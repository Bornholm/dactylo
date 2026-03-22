import type { StorageSchema, ComposeState, AssistMode } from "./types.js";
import { DEFAULT_STORAGE } from "./defaults.js";

type StorageKey = keyof StorageSchema;

/** Lire une clé depuis le storage local */
export async function storageGet<K extends StorageKey>(
  key: K
): Promise<StorageSchema[K]> {
  const result = await browser.storage.local.get(key);
  if (key in result) {
    return result[key] as StorageSchema[K];
  }
  return DEFAULT_STORAGE[key];
}

/** Écrire une valeur dans le storage local */
export async function storageSet<K extends StorageKey>(
  key: K,
  value: StorageSchema[K]
): Promise<void> {
  await browser.storage.local.set({ [key]: value });
}

/** Lire tout le storage */
export async function storageGetAll(): Promise<StorageSchema> {
  const result = await browser.storage.local.get(null);
  return {
    llm: (result["llm"] as StorageSchema["llm"]) ?? DEFAULT_STORAGE.llm,
    systemPrompts: (result["systemPrompts"] as StorageSchema["systemPrompts"]) ?? DEFAULT_STORAGE.systemPrompts,
    mcpServers: (result["mcpServers"] as StorageSchema["mcpServers"]) ?? DEFAULT_STORAGE.mcpServers,
    composeState: (result["composeState"] as StorageSchema["composeState"]) ?? DEFAULT_STORAGE.composeState,
  };
}

/** Lire l'état d'un onglet de composition */
export async function getComposeState(tabId: number): Promise<ComposeState> {
  const allState = await storageGet("composeState");
  const key = String(tabId);
  return allState[key] ?? {
    selectedPromptId: null,
    selectedMode: "improve" as AssistMode,
    conversationHistory: [],
    pendingInstruction: "",
  };
}

/** Sauvegarder l'état d'un onglet de composition */
export async function setComposeState(
  tabId: number,
  state: ComposeState
): Promise<void> {
  const allState = await storageGet("composeState");
  allState[String(tabId)] = state;
  await storageSet("composeState", allState);
}

/** Supprimer l'état d'un onglet (lors de la fermeture) */
export async function deleteComposeState(tabId: number): Promise<void> {
  const allState = await storageGet("composeState");
  delete allState[String(tabId)];
  await storageSet("composeState", allState);
}

/** Générer un UUID simple */
export function generateId(): string {
  return crypto.randomUUID();
}
