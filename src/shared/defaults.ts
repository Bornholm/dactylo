import type { LLMConfig, StorageSchema } from "./types.js";

export const DEFAULT_LLM_CONFIG: LLMConfig = {
  endpoint: "https://api.openai.com/v1",
  apiKey: "",
  model: "gpt-4o",
  temperature: 0.7,
  maxTokens: 2048,
};

export const DEFAULT_STORAGE: StorageSchema = {
  llm: DEFAULT_LLM_CONFIG,
  systemPrompts: [
    {
      id: "default-professional",
      name: "Assistant Pro",
      content: `Tu es un assistant expert en rédaction d'emails professionnels en français. Tu aides à rédiger, corriger et améliorer les emails de manière claire, concise et professionnelle. Réponds uniquement avec le contenu de l'email, sans explications supplémentaires.`,
      isDefault: true,
    },
    {
      id: "default-corrector",
      name: "Correcteur Français",
      content: `Tu es un correcteur orthographique et grammatical expert en français. Corrige uniquement les fautes d'orthographe, de grammaire et de ponctuation sans changer le style ni le fond du message. Réponds uniquement avec le texte corrigé.`,
      isDefault: false,
    },
    {
      id: "default-english",
      name: "English Assistant",
      content: `You are an expert English email writing assistant. Help draft, correct, and improve emails in a clear, concise, and professional manner. Reply only with the email content, without additional explanations.`,
      isDefault: false,
    },
  ],
  mcpServers: [],
  composeState: {},
};

const SCOPE_NOTICE =
  "Note : l'objet (sujet) du courriel et la signature sont gérés séparément — " +
  "ne les inclus pas dans ta réponse ou dans l'appel à update_email.";

// Construire le prompt utilisateur selon le mode
export function buildUserPrompt(
  mode: "correct" | "improve" | "compose",
  emailContent: string,
  instruction?: string
): string {
  switch (mode) {
    case "correct":
      return `Corrige les fautes d'orthographe, de grammaire et de ponctuation dans le corps du courriel suivant.\n${SCOPE_NOTICE}\n\n${emailContent}`;
    case "improve":
      return `Améliore le style et la clarté du corps du courriel suivant tout en conservant le sens original.\n${SCOPE_NOTICE}\n\n${emailContent}`;
    case "compose":
      if (instruction) {
        return `Rédige le corps d'un courriel professionnel basé sur les instructions suivantes.\n${SCOPE_NOTICE}\n\nInstructions : ${instruction}\n\nContexte actuel du corps (si présent) :\n${emailContent}`;
      }
      return `Améliore et complète le corps du courriel suivant.\n${SCOPE_NOTICE}\n\n${emailContent}`;
  }
}
