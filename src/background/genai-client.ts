// Déclarations des globals injectés par wasm_exec.js (Go) et genai.wasm

declare class Go {
  importObject: WebAssembly.Imports;
  run(instance: WebAssembly.Instance): void;
}

interface GenAIClient {
  _id: number;
}

interface GenAIToolSet {
  _id: number;
  count: number;
}

interface GenAITask {
  promise: Promise<void>;
  cancel: () => void;
}

interface GenAIAgent {
  run(message: string, onEvent?: (type: string, data: unknown) => void): GenAITask;
}

interface GenAI {
  createClient(config: {
    provider: string;
    model: string;
    apiKey: string;
    baseURL?: string;
  }): GenAIClient;
  createMCPTools(endpoint: string): Promise<GenAIToolSet>;
  createAgent(client: GenAIClient, config: {
    systemPrompt?: string;
    tools?: GenAIToolSet;
    maxIterations?: number;
    maxTokens?: number;
    temperature?: number;
  }): GenAIAgent;
  registerTool(
    name: string,
    description: string,
    schemaJSON: string,
    callback: (args: Record<string, unknown>) => Promise<string> | string
  ): void;
}

declare const genai: GenAI;

import type { LLMConfig, MCPServer, PopupMessage } from "../shared/types.js";
import { initializeMCPSession, closeMCPSession, listMCPTools, callMCPTool } from "./mcp-client.js";

type UpdateEmailCallback = (tabId: number, content: string, isPlainText: boolean) => Promise<void>;
type OnEmailUpdatedCallback = () => void;

// Variables de contexte mises à jour avant chaque appel agent
let currentTabId = -1;
let currentIsPlainText = true;

// Indique si update_email a été appelé pendant l'appel en cours
let emailUpdatedByTool = false;

// Permet d'annuler la tâche agent depuis le callback d'outil
let currentCancelTask: (() => void) | null = null;

// Callbacks stockés pour le fallback sur complete
let currentOnUpdateEmail: UpdateEmailCallback | null = null;
let currentOnEmailUpdated: OnEmailUpdatedCallback | null = null;

// Annulations actives par tabId
const activeTasks = new Map<number, { cancel: () => void }>();

// Session MCP courante par nom d'outil (mis à jour avant chaque agent.run)
const mcpToolSessionMap = new Map<string, { server: MCPServer; sessionId: string }>();
// Noms des outils déjà enregistrés dans le WASM (évite les doublons)
const registeredMCPToolNames = new Set<string>();

// Promise d'initialisation WASM — permet d'attendre que le runtime soit prêt
let wasmReady: Promise<void> | null = null;

const UPDATE_EMAIL_DESCRIPTION =
  "Remplace le corps du courriel en cours de rédaction par le contenu fourni. " +
  "Utilise cet outil pour appliquer directement tes modifications. " +
  "IMPORTANT : ne pas inclure l'objet (sujet) du courriel dans le contenu. " +
  "IMPORTANT : ne pas inclure la signature — elle est préservée automatiquement.";

const UPDATE_EMAIL_SCHEMA = {
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
};

/** Initialise le runtime WASM et enregistre l'outil update_email. */
export function initGenAI(
  onUpdateEmail: UpdateEmailCallback,
  onEmailUpdated: OnEmailUpdatedCallback
): void {
  currentOnUpdateEmail = onUpdateEmail;
  currentOnEmailUpdated = onEmailUpdated;

  wasmReady = (async () => {
    const go = new Go();
    // Utiliser instantiate + ArrayBuffer pour éviter les problèmes de Content-Type
    // avec les URLs moz-extension:// sous Firefox
    const response = await fetch(browser.runtime.getURL("background/genai.wasm"));
    const buffer = await response.arrayBuffer();
    const result = await WebAssembly.instantiate(buffer, go.importObject);
    // go.run() exécute main() Go de façon synchrone jusqu'à select{}, ce qui
    // définit globalThis.genai avant que go.run() ne rende la main au JS
    go.run(result.instance);

    // genai est maintenant disponible — enregistrer l'outil update_email
    genai.registerTool(
      "update_email",
      UPDATE_EMAIL_DESCRIPTION,
      JSON.stringify(UPDATE_EMAIL_SCHEMA),
      async (args: Record<string, unknown>) => {
        const content = args["content"];
        if (typeof content !== "string") {
          return "Erreur : le paramètre 'content' doit être une chaîne de caractères.";
        }
        try {
          await onUpdateEmail(currentTabId, content, currentIsPlainText);
          emailUpdatedByTool = true;
          onEmailUpdated();
          // Arrêter la boucle agentique : la tâche est terminée
          currentCancelTask?.();
          return "Courriel mis à jour avec succès.";
        } catch (e) {
          return `Erreur lors de la mise à jour du courriel : ${String(e)}`;
        }
      }
    );

    console.log("Dactylo: WASM genai initialisé.");
  })();

  wasmReady.catch((e) => console.error("Dactylo: échec d'initialisation WASM :", e));
}

/** Lance un appel LLM via l'agent WASM. */
export async function callLLM(
  config: LLMConfig,
  systemPrompt: string,
  userMessage: string,
  tabId: number,
  isPlainText: boolean,
  mcpServers: MCPServer[],
  onDone: () => void,
  onError: (error: string) => void
): Promise<void> {
  if (wasmReady) {
    await wasmReady;
  }

  currentTabId = tabId;
  currentIsPlainText = isPlainText;
  emailUpdatedByTool = false;
  currentCancelTask = null;

  const provider = config.provider ?? "openai";
  const client = genai.createClient({
    provider,
    model: config.model,
    apiKey: config.apiKey,
    ...(config.endpoint ? { baseURL: config.endpoint } : {}),
  });

  // Initialiser les sessions MCP et enregistrer chaque outil comme outil JS
  const enabledMCP = mcpServers.filter((s) => s.enabled);
  const mcpSessionIds: string[] = [];
  for (const server of enabledMCP) {
    try {
      const { sessionId } = await initializeMCPSession(server.url, server.headers);
      mcpSessionIds.push(sessionId);
      const tools = await listMCPTools(server.url, sessionId, server.headers);
      for (const tool of tools) {
        // Mettre à jour la session courante pour cet outil (lookup dynamique dans le callback)
        mcpToolSessionMap.set(tool.name, { server, sessionId });

        // N'enregistrer dans le WASM qu'une seule fois par nom d'outil
        // (genai.registerTool() ne dépile jamais : les doublons corrompent le registre Go)
        if (!registeredMCPToolNames.has(tool.name)) {
          registeredMCPToolNames.add(tool.name);
          const toolName = tool.name;
          genai.registerTool(
            toolName,
            tool.description ?? toolName,
            JSON.stringify(tool.inputSchema),
            async (args: Record<string, unknown>) => {
              const execTool = async (): Promise<string> => {
                const session = mcpToolSessionMap.get(toolName);
                if (!session) {
                  return `Erreur : aucune session MCP disponible pour l'outil ${toolName}`;
                }
                const result = await callMCPTool(session.server.url, session.sessionId, toolName, args, session.server.headers);
                const text = result.content
                  .filter((c) => c.type === "text" && c.text)
                  .map((c) => c.text)
                  .join("\n");
                return result.isError ? `Erreur MCP : ${text}` : text || "OK";
              };

              try {
                return await execTool();
              } catch (e) {
                // Si la connexion SSE est tombée, tenter une reconnexion et réessayer
                if (e instanceof Error && e.message === "Connexion SSE interrompue") {
                  const staleSession = mcpToolSessionMap.get(toolName);
                  if (!staleSession) {
                    return `Erreur : impossible de se reconnecter, session introuvable pour ${toolName}`;
                  }
                  try {
                    console.log(`Dactylo: reconnexion MCP pour ${staleSession.server.name}…`);
                    const { sessionId: newSessionId } = await initializeMCPSession(
                      staleSession.server.url,
                      staleSession.server.headers
                    );
                    // Enregistrer la nouvelle session pour fermeture en fin de tâche
                    mcpSessionIds.push(newSessionId);
                    // Mettre à jour toutes les entrées pour ce serveur
                    for (const [name, s] of mcpToolSessionMap.entries()) {
                      if (s.server.url === staleSession.server.url) {
                        mcpToolSessionMap.set(name, { server: s.server, sessionId: newSessionId });
                      }
                    }
                    return await execTool();
                  } catch (reconnErr) {
                    return `Erreur de reconnexion MCP (${staleSession.server.name}) : ${String(reconnErr)}`;
                  }
                }
                return `Erreur lors de l'appel à l'outil ${toolName} : ${String(e)}`;
              }
            }
          );
        }
      }
      console.log(`Dactylo: ${tools.length} outil(s) MCP chargé(s) depuis ${server.name}`);
    } catch (e) {
      const errMsg = `Connexion MCP échouée pour « ${server.name} » : ${String(e)}`;
      console.warn("Dactylo:", errMsg);
      browser.runtime.sendMessage({ action: "BACKGROUND_ERROR", message: errMsg } as PopupMessage).catch(() => {});
    }
  }

  const agent = genai.createAgent(client, {
    systemPrompt,
    maxIterations: 20,
    maxTokens: config.maxTokens,
    temperature: config.temperature,
  });

  // Le callback est appelé de façon SYNCHRONE par Go (la Promise retournée est ignorée).
  // On stocke juste le message pour l'appliquer après la résolution de task.promise.
  let pendingMessage: string | null = null;

  const task = agent.run(userMessage, (type: string, data: unknown) => {
    if (type === "complete" && !emailUpdatedByTool) {
      const msg = (data as Record<string, unknown> | null)?.["Message"];
      if (typeof msg === "string" && msg.trim()) {
        pendingMessage = msg.trim();
      }
    }
  });
  activeTasks.set(tabId, task);
  currentCancelTask = task.cancel;

  task.promise
    .then(async () => {
      // Fallback : si l'agent n'a pas appelé update_email, appliquer le message final
      if (pendingMessage && !emailUpdatedByTool && currentOnUpdateEmail && currentOnEmailUpdated) {
        try {
          await currentOnUpdateEmail(currentTabId, pendingMessage, currentIsPlainText);
          currentOnEmailUpdated();
        } catch (e) {
          const errMsg = `Erreur lors de l'application du message final : ${String(e)}`;
          console.error("Dactylo:", errMsg);
          browser.runtime.sendMessage({ action: "BACKGROUND_ERROR", message: errMsg } as PopupMessage).catch(() => {});
        }
      }
      onDone();
    })
    .catch((e: unknown) => onError(String(e)))
    .finally(() => {
      activeTasks.delete(tabId);
      for (const sessionId of mcpSessionIds) {
        closeMCPSession(sessionId);
      }
    });
}

/** Annule un appel LLM en cours. */
export function cancelLLMStream(tabId: number): void {
  activeTasks.get(tabId)?.cancel();
  activeTasks.delete(tabId);
}
