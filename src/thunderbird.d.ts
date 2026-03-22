/**
 * Déclarations de type pour les APIs Thunderbird (MailExtensions)
 * non couvertes par @types/firefox-webext-browser
 */

interface ComposeDetails {
  body?: string;
  plainTextBody?: string;
  isPlainText?: boolean;
  subject?: string;
  to?: string[];
  cc?: string[];
  bcc?: string[];
  /** Expéditeur sélectionné (ex: "Prénom Nom <email@example.com>"). */
  from?: string;
  /** ID du message d'origine (réponse, transfert, brouillon). Thunderbird 95+. */
  relatedMessageId?: number;
}

interface ComposeAttachment {
  id: number;
  name?: string;
  size?: number;
}

interface ComposeAPI {
  getComposeDetails(tabId: number): Promise<ComposeDetails>;
  setComposeDetails(tabId: number, details: Partial<ComposeDetails>): Promise<void>;
  listAttachments(tabId: number): Promise<ComposeAttachment[]>;
}

/** Partie MIME d'un message retournée par messages.getFull() */
interface MessagePart {
  body?: string;
  contentType: string;
  headers?: Record<string, string[]>;
  name?: string;
  partName?: string;
  parts?: MessagePart[];
  size?: number;
}

interface MessagesAPI {
  getFull(messageId: number): Promise<MessagePart>;
}

declare namespace browser {
  const compose: ComposeAPI;
  const messages: MessagesAPI;
}
