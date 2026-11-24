export const CONVERSATION_HANDLER = Symbol('CONVERSATION_HANDLER');

export type ConversationInput = {
  telegramId: string;
  text: string;
  languageCode?: string;
  firstName?: string;
  contactPhone?: string;
};

export interface ConversationHandler {
  handleMessage(input: ConversationInput): Promise<string>;
}
