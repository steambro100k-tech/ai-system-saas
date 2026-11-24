export type LlmToolDefinition = {
  type: 'function';
  function: {
    name: string;
    description?: string;
    parameters: Record<string, unknown>;
  };
};

export type LlmToolCall = {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
};

export type LlmMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string | null; tool_calls?: LlmToolCall[] }
  | { role: 'tool'; tool_call_id: string; content: string };

export type LlmCompletionResult = {
  message: {
    role: 'assistant';
    content: string | null;
    tool_calls?: LlmToolCall[];
  };
  model?: string;
  elapsedMs?: number;
};

export interface LlmClient {
  createChatCompletion(params: {
    messages: LlmMessage[];
    tools?: LlmToolDefinition[];
    toolChoice?: 'auto' | 'none';
    temperature?: number;
    iteration?: number;
    reasoningEffort?: string;
  }): Promise<LlmCompletionResult>;
}
