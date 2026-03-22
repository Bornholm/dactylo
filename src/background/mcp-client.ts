/** Client MCP Streamable HTTP (transport HTTP uniquement) */

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

/** Initialiser une session MCP avec un serveur HTTP */
export async function initializeMCPSession(
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

  // Envoyer la notification initialized
  await fetch(serverUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...extraHeaders,
      ...(sessionId ? { "mcp-session-id": sessionId } : {}),
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      method: "notifications/initialized",
    }),
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
  const response = await fetch(serverUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...extraHeaders,
      ...(sessionId ? { "mcp-session-id": sessionId } : {}),
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
      params: {},
    }),
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
      params: {
        name: toolName,
        arguments: toolArgs,
      },
    }),
  });

  if (!response.ok) {
    throw new Error(`MCP tools/call failed: HTTP ${response.status}`);
  }

  const data = (await response.json()) as { result?: MCPCallResult };
  return data.result ?? { content: [] };
}
