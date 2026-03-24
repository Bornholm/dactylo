// Configuration du serveur LLM
export interface LLMConfig {
  provider: "openai" | "mistral" | "openrouter";
  endpoint: string;
  apiKey: string;
  model: string;
  temperature: number;
  maxTokens: number;
}

// Prompt système nommé
export interface SystemPrompt {
  id: string;
  name: string;
  content: string;
  isDefault: boolean;
}

// Serveur MCP Streamable HTTP
export interface MCPServer {
  id: string;
  name: string;
  url: string;
  enabled: boolean;
  lastStatus: "connected" | "disconnected" | "error" | "unknown";
  headers?: Record<string, string>;
}

// Mode d'assistance
export type AssistMode = "correct" | "improve" | "compose";

// Message dans l'historique de conversation
export interface ConversationMessage {
  role: "user" | "assistant";
  content: string;
}

// État du panel de composition par tabId
export interface ComposeState {
  selectedPromptId: string | null;
  selectedMode: AssistMode;
  conversationHistory: ConversationMessage[];
  pendingInstruction: string;
}

// Schéma complet du storage
export interface StorageSchema {
  llm: LLMConfig;
  systemPrompts: SystemPrompt[];
  mcpServers: MCPServer[];
  composeState: Record<string, ComposeState>;
}

// Définition d'un outil LLM (format OpenAI function calling)
export interface ToolDefinition {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: {
      type: "object";
      properties: Record<string, { type: string; description: string }>;
      required: string[];
    };
  };
}

// Messages échangés entre le popup et le background script
export type BackgroundMessage =
  | { action: "GET_COMPOSE_CONTENT"; tabId: number }
  | { action: "LLM_REQUEST"; tabId: number; systemPrompt: string; userMessage: string; history: ConversationMessage[]; mode: AssistMode }
  | { action: "LLM_CANCEL"; tabId: number }
  | { action: "APPLY_CONTENT"; tabId: number; content: string; isPlainText: boolean }
  | { action: "TEST_LLM_CONNECTION" }
  | { action: "TEST_MCP_CONNECTION"; url: string; headers?: Record<string, string> }
  | { action: "KEEPALIVE" };

export type PopupMessage =
  | { action: "EMAIL_UPDATED" }
  | { action: "BACKGROUND_ERROR"; message: string };

// Métadonnées du courriel retournées avec le contenu
export interface ComposeContext {
  content: string;
  isPlainText: boolean;
  subject?: string;
  from?: string;
  to?: string[];
  cc?: string[];
  bcc?: string[];
  attachmentNames?: string[];
  /** Corps du message d'origine (thread de réponse), texte brut */
  thread?: string;
}

export type BackgroundResponse =
  | ({ success: true } & Partial<ComposeContext>)
  | { success: false; error: string };
