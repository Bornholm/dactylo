import type { BackgroundMessage, BackgroundResponse, PopupMessage, ToolDefinition } from "../shared/types.js";
import { storageGet, getComposeState, setComposeState, deleteComposeState } from "../shared/storage.js";
import { callLLM, cancelLLMStream, type ChatMessage } from "./llm-client.js";

/** Outil exposé au LLM pour éditer directement le corps du courriel */
const UPDATE_EMAIL_TOOL: ToolDefinition = {
  type: "function",
  function: {
    name: "update_email",
    description:
      "Remplace le corps du courriel en cours de rédaction par le contenu fourni. " +
      "Utilise cet outil pour appliquer directement tes modifications. " +
      "IMPORTANT : ne pas inclure l'objet (sujet) du courriel dans le contenu. " +
      "IMPORTANT : ne pas inclure la signature — elle est préservée automatiquement.",
    parameters: {
      type: "object",
      properties: {
        content: {
          type: "string",
          description:
            "Le nouveau corps du courriel uniquement (texte brut, sans HTML). " +
            "Ne pas inclure l'objet ni la signature.",
        },
      },
      required: ["content"],
    },
  },
};

// Signature préservée par tabId (lue une seule fois au début du LLM_REQUEST)
const storedSignatures = new Map<number, string>();

// Bloc de citation du thread (moz-cite-prefix + blockquote) préservé par tabId pour les réponses
const storedThreadTails = new Map<number, string>();

/**
 * Pour les emails HTML : extrait la signature HTML (div.moz-signature ou pre.moz-signature)
 * avant de strip le HTML, pour la préserver telle quelle lors de la réécriture.
 * Retourne { bodyHtml, signatureHtml }.
 */
function extractSignatureFromHtml(html: string): { bodyHtml: string; signatureHtml: string } {
  // Thunderbird insère la signature dans un élément avec class="moz-signature"
  const match = /(<(?:div|pre)[^>]+class="[^"]*moz-signature[^"]*"[^>]*>[\s\S]*)$/i.exec(html);
  if (match) {
    const sigIndex = match.index;
    // Supprimer les <br> isolés juste avant la signature
    const bodyPart = html.slice(0, sigIndex).replace(/(?:<br\s*\/?>|\s)*$/i, "");
    return { bodyHtml: bodyPart, signatureHtml: html.slice(sigIndex) };
  }
  return { bodyHtml: html, signatureHtml: "" };
}

/**
 * Pour les emails en texte brut : sépare le corps de la signature via le délimiteur RFC 3676.
 */
function extractSignatureFromText(text: string): { body: string; signatureText: string } {
  const delimiters = ["\n-- \n", "\n--\n", "\n-- \r\n", "\n--\r\n"];
  for (const delim of delimiters) {
    const idx = text.indexOf(delim);
    if (idx !== -1) {
      return {
        body: text.slice(0, idx).trimEnd(),
        signatureText: text.slice(idx),
      };
    }
  }
  return { body: text, signatureText: "" };
}

/**
 * Extrait le bloc de citation (moz-cite-prefix + blockquote) depuis le corps HTML d'une réponse.
 * Retourne la portion à partir du cite-prefix ou du premier blockquote.
 */
function extractHtmlThreadTail(html: string): string {
  const citePrefixIdx = html.search(/<div[^>]+class="[^"]*moz-cite-prefix[^"]*"/i);
  if (citePrefixIdx !== -1) return html.slice(citePrefixIdx);
  const bqIdx = html.search(/<blockquote/i);
  if (bqIdx !== -1) return html.slice(bqIdx);
  return "";
}

/**
 * Extrait le bloc de citation depuis un corps texte brut d'une réponse.
 * Retourne la portion à partir de la ligne d'introduction de la citation.
 */
function extractPlainTextThreadTail(text: string): string {
  const citationPattern = /\n(?:Le |On )[^\n]*(?:a écrit|wrote)\s*:\s*\n/i;
  const match = citationPattern.exec(text);
  if (match?.index !== undefined) return text.slice(match.index);
  const lines = text.split("\n");
  const quoteStart = lines.findIndex(l => l.trimStart().startsWith(">"));
  if (quoteStart > 0) return "\n" + lines.slice(quoteStart).join("\n");
  return "";
}

/**
 * Convertit du texte brut (réponse du LLM) en HTML pour Thunderbird.
 * - Blocs séparés par 2+ sauts de ligne → balises <p> distinctes
 * - Sauts de ligne simples au sein d'un bloc → <br>
 * Évite les paragraphes vides superflus qui créent du double espacement.
 */
function textToHtml(text: string): string {
  return text
    .trim()
    .split(/\n{2,}/)
    .map((para) => {
      const inner = para
        .split("\n")
        .map((line) => escapeHtml(line))
        .join("<br>");
      return `<p>${inner}</p>`;
    })
    .join("");
}

// Écouter les messages du popup
browser.runtime.onMessage.addListener(
  (rawMessage: unknown, sender): Promise<BackgroundResponse> | true => {
    const message = rawMessage as BackgroundMessage;

    switch (message.action) {
      case "GET_COMPOSE_CONTENT":
        return handleGetComposeContent(message.tabId);

      case "LLM_REQUEST":
        return handleLLMRequest(message, sender.tab?.id ?? -1);

      case "LLM_CANCEL":
        cancelLLMStream(message.tabId);
        return Promise.resolve({ success: true });

      case "APPLY_CONTENT":
        return handleApplyContent(message.tabId, message.content, message.isPlainText);

      case "TEST_LLM_CONNECTION":
        return handleTestLLMConnection();

      case "TEST_MCP_CONNECTION":
        return handleTestMCPConnection(message.url, message.headers);

      default:
        return Promise.resolve({ success: false, error: "Action inconnue" });
    }
  }
);

// Nettoyer l'état quand un onglet de composition se ferme
browser.tabs.onRemoved.addListener((tabId) => {
  deleteComposeState(tabId).catch(console.error);
  storedSignatures.delete(tabId);
  storedThreadTails.delete(tabId);
});

async function handleGetComposeContent(tabId: number): Promise<BackgroundResponse> {
  try {
    const [details, attachments] = await Promise.all([
      browser.compose.getComposeDetails(tabId),
      browser.compose.listAttachments(tabId).catch(() => [] as ComposeAttachment[]),
    ]);

    const isPlainText = details.isPlainText ?? false;

    // Extraire le corps en retirant la signature
    let rawBody: string;
    if (isPlainText) {
      const { body: b } = extractSignatureFromText(details.plainTextBody ?? "");
      rawBody = b;
    } else {
      const { bodyHtml } = extractSignatureFromHtml(details.body ?? "");
      rawBody = stripHtml(bodyHtml);
    }

    // Pour une réponse : séparer la rédaction en cours du thread cité
    let body = rawBody;
    let thread: string | undefined;

    if (details.relatedMessageId != null) {
      // Isoler uniquement le texte rédigé par l'utilisateur
      body = extractUserBodyFromReply(rawBody, isPlainText);

      // Récupérer le message d'origine pour fournir le thread complet au LLM
      try {
        const originalPart = await browser.messages.getFull(details.relatedMessageId);
        const threadText = extractTextFromMessagePart(originalPart);
        if (threadText) thread = threadText;
      } catch {
        // L'accès au message d'origine peut échouer (message supprimé, etc.) — on continue sans thread
      }
    }

    return {
      success: true,
      content: body,
      isPlainText,
      ...(details.from                   ? { from: details.from }                                 : {}),
      ...(details.subject                ? { subject: details.subject }                          : {}),
      ...(details.to?.length             ? { to: details.to }                                    : {}),
      ...(details.cc?.length             ? { cc: details.cc }                                    : {}),
      ...(details.bcc?.length            ? { bcc: details.bcc }                                  : {}),
      ...(attachments.length             ? { attachmentNames: attachments.map(a => a.name ?? "sans nom") } : {}),
      ...(thread                         ? { thread }                                             : {}),
    };
  } catch (e) {
    return { success: false, error: String(e) };
  }
}

async function handleLLMRequest(
  message: Extract<BackgroundMessage, { action: "LLM_REQUEST" }>,
  senderTabId: number
): Promise<BackgroundResponse> {
  const { tabId, systemPrompt, userMessage, history, mode } = message;


  // Construire les messages à envoyer au LLM
  const messages: ChatMessage[] = [
    { role: "system", content: systemPrompt },
    ...history.map((m) => ({ role: m.role, content: m.content })),
    { role: "user", content: userMessage },
  ];

  const llmConfig = await storageGet("llm");

  // Lire le format, stocker la signature et le thread tail une seule fois avant le streaming
  let isPlainText = false;
  try {
    const details = await browser.compose.getComposeDetails(tabId);
    isPlainText = details.isPlainText ?? false;
    if (isPlainText) {
      const raw = details.plainTextBody ?? "";
      const { body: bodyWithoutSig, signatureText } = extractSignatureFromText(raw);
      storedSignatures.set(tabId, signatureText);
      storedThreadTails.set(tabId, extractPlainTextThreadTail(bodyWithoutSig));
    } else {
      const raw = details.body ?? "";
      const { bodyHtml, signatureHtml } = extractSignatureFromHtml(raw);
      storedSignatures.set(tabId, signatureHtml);
      // Le thread tail est dans bodyHtml si la signature est après le blockquote,
      // ou dans signatureHtml si la signature est avant (Thunderbird le transporte avec elle).
      storedThreadTails.set(tabId, extractHtmlThreadTail(bodyHtml));
    }
  } catch {
    isPlainText = true;
  }

  return new Promise<BackgroundResponse>((resolve) => {
    const onDone = () => {
      resolve({ success: true });
    };

    const onError = (error: string) => {
      resolve({ success: false, error });
    };

    // Exécuteur des outils : update_email applique le contenu directement
    const executor = async (name: string, args: Record<string, unknown>): Promise<string> => {
      if (name === "update_email") {
        const content = args["content"];
        if (typeof content !== "string") {
          return "Erreur : le paramètre 'content' doit être une chaîne de caractères.";
        }
        try {
          await applyBodyText(tabId, content, isPlainText);
          const msg: PopupMessage = { action: "EMAIL_UPDATED" };
          browser.runtime.sendMessage(msg).catch(() => {});
          return "Courriel mis à jour avec succès.";
        } catch (e) {
          return `Erreur lors de la mise à jour du courriel : ${String(e)}`;
        }
      }
      return `Outil inconnu : ${name}`;
    };

    callLLM(llmConfig, messages, [UPDATE_EMAIL_TOOL], tabId, onDone, onError, executor);
  });
}

/**
 * Applique le corps fourni par le LLM (texte brut) dans la fenêtre de composition,
 * en réattachant la signature préservée et en convertissant vers le bon format.
 */
async function applyBodyText(tabId: number, bodyText: string, isPlainText: boolean): Promise<void> {
  const signature  = storedSignatures.get(tabId)  ?? "";
  const threadTail = storedThreadTails.get(tabId) ?? "";
  if (isPlainText) {
    // Ordre : [nouveau contenu][saut de ligne + citation][signature]
    const full = bodyText + threadTail + signature;
    await browser.compose.setComposeDetails(tabId, { plainTextBody: full });
  } else {
    const bodyHtml = textToHtml(bodyText);
    // Si signature avant blockquote : signature contient déjà le threadTail
    // Si signature après blockquote : threadTail est séparé
    const fullHtml = bodyHtml + threadTail + signature;
    await browser.compose.setComposeDetails(tabId, { body: fullHtml });
  }
}

async function handleApplyContent(
  tabId: number,
  content: string,
  isPlainText: boolean
): Promise<BackgroundResponse> {
  try {
    await applyBodyText(tabId, content, isPlainText);
    return { success: true };
  } catch (e) {
    return { success: false, error: String(e) };
  }
}


async function handleTestLLMConnection(): Promise<BackgroundResponse> {
  try {
    const config = await storageGet("llm");
    const response = await fetch(`${config.endpoint}/models`, {
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
      },
    });
    if (!response.ok) {
      return { success: false, error: `HTTP ${response.status}: ${response.statusText}` };
    }
    return { success: true };
  } catch (e) {
    return { success: false, error: String(e) };
  }
}

async function handleTestMCPConnection(url: string, extraHeaders?: Record<string, string>): Promise<BackgroundResponse> {
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...extraHeaders },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "Dactylo", version: "0.1.0" },
        },
      }),
    });
    if (!response.ok) {
      return { success: false, error: `HTTP ${response.status}: ${response.statusText}` };
    }
    return { success: true };
  } catch (e) {
    return { success: false, error: String(e) };
  }
}

/**
 * Extrait la partie du corps rédigée par l'utilisateur en supprimant
 * le contenu cité (blockquote HTML ou lignes "> " en texte brut).
 */
function extractUserBodyFromReply(body: string, isPlainText: boolean): string {
  if (isPlainText) {
    // Cherche la ligne d'introduction de la citation ("Le ..., ... a écrit :" ou "On ..., ... wrote:")
    const citationPattern = /\n(?:Le |On )[^\n]*(?:a écrit|wrote)\s*:\s*\n/i;
    const citationIdx = body.search(citationPattern);
    if (citationIdx !== -1) {
      return body.slice(0, citationIdx).trimEnd();
    }
    // Fallback : première ligne commençant par ">"
    const lines = body.split("\n");
    const quoteStart = lines.findIndex(l => l.trimStart().startsWith(">"));
    if (quoteStart > 0) {
      return lines.slice(0, quoteStart).join("\n").trimEnd();
    }
    return body;
  } else {
    // HTML : supprimer tout ce qui est dans un <blockquote
    const bqIdx = body.search(/<blockquote/i);
    if (bqIdx !== -1) {
      return body.slice(0, bqIdx).replace(/(?:<br\s*\/?>|\s)*$/i, "");
    }
    return body;
  }
}

/**
 * Extrait récursivement le texte brut d'une structure MessagePart MIME.
 * Préfère text/plain ; repli sur text/html converti.
 */
function extractTextFromMessagePart(part: MessagePart): string {
  if (part.contentType.startsWith("text/plain") && part.body) {
    return part.body.trim();
  }
  if (part.parts && part.parts.length > 0) {
    // Chercher d'abord un text/plain dans les sous-parties
    for (const child of part.parts) {
      const plain = extractTextFromPart(child, "text/plain");
      if (plain) return plain.trim();
    }
    // Repli : premier text/html
    for (const child of part.parts) {
      const html = extractTextFromPart(child, "text/html");
      if (html) return stripHtml(html).trim();
    }
  }
  if (part.contentType.startsWith("text/html") && part.body) {
    return stripHtml(part.body).trim();
  }
  return "";
}

function extractTextFromPart(part: MessagePart, targetType: string): string | null {
  if (part.contentType.startsWith(targetType) && part.body) {
    return part.body;
  }
  if (part.parts) {
    for (const child of part.parts) {
      const result = extractTextFromPart(child, targetType);
      if (result) return result;
    }
  }
  return null;
}

function stripHtml(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .trim();
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
