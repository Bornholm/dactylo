import type { LLMConfig, ToolDefinition } from "../shared/types.js";

export type ChatMessage = {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
};

interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

/** Exécuteur d'un outil : reçoit le nom et les arguments parsés, retourne le résultat */
export type ToolExecutor = (
  name: string,
  args: Record<string, unknown>
) => Promise<string>;

// Map des requêtes actives par tabId pour permettre l'annulation
const activeControllers = new Map<number, AbortController>();

/** Lancer un appel LLM avec support des tool calls */
export function callLLM(
  config: LLMConfig,
  messages: ChatMessage[],
  tools: ToolDefinition[],
  tabId: number,
  onDone: () => void,
  onError: (error: string) => void,
  executor: ToolExecutor
): void {
  const controller = new AbortController();
  activeControllers.set(tabId, controller);

  agenticLoop(config, messages, tools, controller.signal, onDone, onError, executor).finally(() => {
    activeControllers.delete(tabId);
  });
}

/** Annuler une requête en cours */
export function cancelLLMStream(tabId: number): void {
  const controller = activeControllers.get(tabId);
  if (controller) {
    controller.abort();
    activeControllers.delete(tabId);
  }
}

/**
 * Boucle agentique : appel LLM → si tool_calls → exécuter → continuer.
 * Se termine sur finish_reason === "stop" ou après un outil terminal.
 */
async function agenticLoop(
  config: LLMConfig,
  messages: ChatMessage[],
  tools: ToolDefinition[],
  signal: AbortSignal,
  onDone: () => void,
  onError: (error: string) => void,
  executor: ToolExecutor,
  depth = 0
): Promise<void> {
  if (depth > 10) {
    onError("Trop d'appels d'outils consécutifs (limite de 10 atteinte).");
    return;
  }

  try {
    const body: Record<string, unknown> = {
      model: config.model,
      messages,
      temperature: config.temperature,
      max_tokens: config.maxTokens,
    };
    if (tools.length > 0) {
      body["tools"] = tools;
      body["tool_choice"] = "auto";
    }

    const response = await fetch(`${config.endpoint}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify(body),
      signal,
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => response.statusText);
      let errorMsg = `Erreur ${response.status}`;
      try {
        const errJson = JSON.parse(errorText) as Record<string, unknown>;
        const detail = (errJson["error"] as Record<string, unknown> | undefined)?.["message"];
        errorMsg += `: ${typeof detail === "string" ? detail : errorText}`;
      } catch {
        errorMsg += `: ${errorText}`;
      }
      onError(errorMsg);
      return;
    }

    const json = await response.json() as Record<string, unknown>;
    const choice = (json["choices"] as Array<Record<string, unknown>> | undefined)?.[0];
    if (!choice) {
      onError("Réponse API invalide : aucun choix retourné.");
      return;
    }

    const finishReason = choice["finish_reason"] as string | null;
    const message = choice["message"] as Record<string, unknown> | undefined;
    if (!message) {
      onError("Réponse API invalide : message manquant.");
      return;
    }

    const toolCalls = message["tool_calls"] as ToolCall[] | undefined;

    if (finishReason === "tool_calls" && toolCalls?.length) {
      const assistantMessage: ChatMessage = {
        role: "assistant",
        content: (message["content"] as string | null) ?? null,
        tool_calls: toolCalls,
      };

      const updatedMessages = [...messages, assistantMessage];

      for (const tc of toolCalls) {
        let result: string;
        try {
          const args = JSON.parse(tc.function.arguments) as Record<string, unknown>;
          result = await executor(tc.function.name, args);
        } catch (e) {
          result = `Erreur lors de l'exécution de ${tc.function.name}: ${String(e)}`;
        }

        updatedMessages.push({
          role: "tool",
          tool_call_id: tc.id,
          content: result,
        });
      }

      // update_email est un outil terminal : on s'arrête après son exécution.
      // Les outils MCP intermédiaires continuent la boucle.
      const hasTerminalTool = toolCalls.some(tc => tc.function.name === "update_email");
      if (hasTerminalTool) {
        onDone();
      } else {
        await agenticLoop(config, updatedMessages, tools, signal, onDone, onError, executor, depth + 1);
      }

    } else {
      onDone();
    }

  } catch (e) {
    if ((e as Error).name === "AbortError") {
      onDone();
    } else {
      onError(String(e));
    }
  }
}
