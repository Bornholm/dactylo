/** Client MCP - supporte Streamable HTTP et SSE (avec en-têtes HTTP personnalisés) */

interface MCPInitializeResult {
  sessionId: string;
  capabilities: Record<string, unknown>;
}

interface MCPTool {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}

interface MCPCallResult {
  content: Array<{ type: string; text?: string }>;
  isError?: boolean;
}

interface SSESession {
  close: () => void;
  postUrl: string;
  pending: Map<number | string, (data: unknown) => void>;
}

// Sessions SSE actives (clé = sessionId généré côté client)
const sseSessions = new Map<string, SSESession>();

function isSSEUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return u.pathname.endsWith("/sse") || u.pathname.includes("/sse/");
  } catch {
    return false;
  }
}

function generateSessionId(): string {
  return `sse-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/** Parse un flux SSE via fetch (supporte les en-têtes HTTP personnalisés) */
async function openSSESession(
  sseUrl: string,
  extraHeaders?: Record<string, string>
): Promise<{ sessionId: string }> {
  const response = await fetch(sseUrl, {
    method: "GET",
    headers: {
      Accept: "text/event-stream",
      "Cache-Control": "no-cache",
      ...extraHeaders,
    },
  });

  if (!response.ok) {
    throw new Error(`Connexion SSE échouée: HTTP ${response.status}`);
  }
  if (!response.body) {
    throw new Error("Le serveur SSE n'a pas retourné de corps de réponse");
  }

  const sessionId = generateSessionId();
  const pending = new Map<number | string, (data: unknown) => void>();
  const reader = response.body.getReader();

  return new Promise((resolve, reject) => {
    const decoder = new TextDecoder();
    let buffer = "";
    let currentEventType = "message";
    let currentEventData = "";

    function dispatchEvent(type: string, data: string) {
      if (type === "endpoint") {
        const endpointData = data.trim();
        let postUrl: string;
        try {
          postUrl = new URL(endpointData, new URL(sseUrl).origin).toString();
        } catch {
          postUrl = endpointData;
        }

        sseSessions.set(sessionId, { close: () => reader.cancel(), postUrl, pending });
        resolve({ sessionId });
      } else {
        // Réponse JSON-RPC sur le flux SSE
        try {
          const parsed = JSON.parse(data) as { id?: number | string };
          if (parsed.id !== undefined) {
            const callback = pending.get(parsed.id);
            if (callback) {
              pending.delete(parsed.id);
              callback(parsed);
            }
          }
        } catch {
          // Ignorer les messages malformés
        }
      }
    }

    function processLine(line: string) {
      if (line === "") {
        // Ligne vide = fin d'un événement
        if (currentEventData !== "") {
          dispatchEvent(currentEventType, currentEventData);
        }
        currentEventType = "message";
        currentEventData = "";
      } else if (line.startsWith("event:")) {
        currentEventType = line.slice(6).trim();
      } else if (line.startsWith("data:")) {
        const chunk = line.slice(5).trimStart();
        currentEventData = currentEventData === "" ? chunk : `${currentEventData}\n${chunk}`;
      }
      // id: et retry: ignorés
    }

    async function readStream() {
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? ""; // Conserver la ligne incomplète

          for (const line of lines) {
            processLine(line.replace(/\r$/, "")); // Normaliser CRLF
          }
        }
      } catch (err) {
        if (!sseSessions.has(sessionId)) {
          reject(err instanceof Error ? err : new Error(String(err)));
        }
      }
    }

    readStream();

    setTimeout(() => {
      if (!sseSessions.has(sessionId)) {
        reader.cancel();
        reject(new Error("Timeout: aucun événement 'endpoint' SSE reçu"));
      }
    }, 10000);
  });
}

/** Envoie une requête JSON-RPC via SSE et attend la réponse sur le flux */
async function postSSE(
  sessionId: string,
  method: string,
  params: object,
  extraHeaders?: Record<string, string>
): Promise<unknown> {
  const session = sseSessions.get(sessionId);
  if (!session) throw new Error("Session SSE introuvable");

  const requestId = Date.now();

  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      session.pending.delete(requestId);
      reject(new Error(`Timeout MCP SSE pour la méthode: ${method}`));
    }, 30000);

    session.pending.set(requestId, (data) => {
      clearTimeout(timeout);
      resolve(data);
    });

    fetch(session.postUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...extraHeaders },
      body: JSON.stringify({ jsonrpc: "2.0", id: requestId, method, params }),
    }).then((response) => {
      if (!response.ok) {
        clearTimeout(timeout);
        session.pending.delete(requestId);
        reject(new Error(`MCP SSE POST échoué: HTTP ${response.status}`));
      }
      // La réponse arrive via le flux SSE
    }).catch((err: unknown) => {
      clearTimeout(timeout);
      session.pending.delete(requestId);
      reject(err);
    });
  });
}

/** Ferme une session SSE et libère les ressources */
export function closeMCPSession(sessionId: string): void {
  const session = sseSessions.get(sessionId);
  if (session) {
    session.close();
    sseSessions.delete(sessionId);
  }
}

/** Initialiser une session MCP (auto-détection SSE vs Streamable HTTP selon l'URL) */
export async function initializeMCPSession(
  serverUrl: string,
  extraHeaders?: Record<string, string>
): Promise<MCPInitializeResult> {
  if (isSSEUrl(serverUrl)) {
    return initializeMCPSessionSSE(serverUrl, extraHeaders);
  }
  return initializeMCPSessionHTTP(serverUrl, extraHeaders);
}

async function initializeMCPSessionSSE(
  sseUrl: string,
  extraHeaders?: Record<string, string>
): Promise<MCPInitializeResult> {
  const { sessionId } = await openSSESession(sseUrl, extraHeaders);

  const data = (await postSSE(sessionId, "initialize", {
    protocolVersion: "2024-11-05",
    capabilities: { tools: {} },
    clientInfo: { name: "Dactylo", version: "0.1.0" },
  }, extraHeaders)) as { result?: { capabilities?: Record<string, unknown> } };

  // Envoyer la notification initialized (pas de réponse attendue)
  const session = sseSessions.get(sessionId)!;
  await fetch(session.postUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...extraHeaders },
    body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
  });

  return {
    sessionId,
    capabilities: data.result?.capabilities ?? {},
  };
}

async function initializeMCPSessionHTTP(
  serverUrl: string,
  extraHeaders?: Record<string, string>
): Promise<MCPInitializeResult> {
  const response = await fetch(serverUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...extraHeaders },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: { tools: {} },
        clientInfo: { name: "Dactylo", version: "0.1.0" },
      },
    }),
  });

  if (!response.ok) {
    throw new Error(`MCP initialize failed: HTTP ${response.status}`);
  }

  const sessionId = response.headers.get("mcp-session-id") ?? "";
  const data = (await response.json()) as { result?: { capabilities?: Record<string, unknown> } };

  await fetch(serverUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...extraHeaders,
      ...(sessionId ? { "mcp-session-id": sessionId } : {}),
    },
    body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
  });

  return {
    sessionId,
    capabilities: data.result?.capabilities ?? {},
  };
}

/** Lister les outils disponibles sur un serveur MCP */
export async function listMCPTools(
  serverUrl: string,
  sessionId: string,
  extraHeaders?: Record<string, string>
): Promise<MCPTool[]> {
  if (sseSessions.has(sessionId)) {
    const data = (await postSSE(sessionId, "tools/list", {}, extraHeaders)) as {
      result?: { tools?: MCPTool[] };
    };
    return data.result?.tools ?? [];
  }

  const response = await fetch(serverUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...extraHeaders,
      ...(sessionId ? { "mcp-session-id": sessionId } : {}),
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
  });

  if (!response.ok) {
    throw new Error(`MCP tools/list failed: HTTP ${response.status}`);
  }

  const data = (await response.json()) as { result?: { tools?: MCPTool[] } };
  return data.result?.tools ?? [];
}

/** Appeler un outil MCP */
export async function callMCPTool(
  serverUrl: string,
  sessionId: string,
  toolName: string,
  toolArgs: Record<string, unknown>,
  extraHeaders?: Record<string, string>
): Promise<MCPCallResult> {
  if (sseSessions.has(sessionId)) {
    const data = (await postSSE(
      sessionId,
      "tools/call",
      { name: toolName, arguments: toolArgs },
      extraHeaders
    )) as { result?: MCPCallResult };
    return data.result ?? { content: [] };
  }

  const response = await fetch(serverUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...extraHeaders,
      ...(sessionId ? { "mcp-session-id": sessionId } : {}),
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: Date.now(),
      method: "tools/call",
      params: { name: toolName, arguments: toolArgs },
    }),
  });

  if (!response.ok) {
    throw new Error(`MCP tools/call failed: HTTP ${response.status}`);
  }

  const data = (await response.json()) as { result?: MCPCallResult };
  return data.result ?? { content: [] };
}
