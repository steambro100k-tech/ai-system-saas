import OpenAI from 'openai';
import { Logger } from '@nestjs/common';
import { getAppEnv } from '../../common/config/env';
import {
  LlmClient,
  LlmCompletionResult,
  LlmMessage,
  LlmToolDefinition,
} from './llm-client.interface';

const DEFAULT_GEMINI_FALLBACK_MODEL = 'gemini-3.5-flash-lite';

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isTimeoutError(e: any): boolean {
  if (!e) return false;
  const name = String(e.name || '');
  const code = String(e.code || '');
  const msg = String(e.message || '').toLowerCase();
  return (
    name.includes('Timeout') ||
    code === 'ETIMEDOUT' ||
    code === 'ECONNABORTED' ||
    msg.includes('timeout') ||
    msg.includes('timed out')
  );
}

function getStatus(e: any): number | 'timeout' | 'unknown' {
  if (isTimeoutError(e)) return 'timeout';
  const status = e?.status ?? e?.response?.status;
  if (typeof status === 'number') return status;
  return 'unknown';
}

function errorSummary(e: any): string {
  const raw = e?.error?.message ?? e?.message ?? String(e);
  return String(raw).replace(/\s+/g, ' ').slice(0, 200);
}

function jitter(ms: number): number {
  return ms + Math.floor(Math.random() * 250);
}

export type OpenAiClientOptions = {
  apiKey?: string;
  baseURL?: string;
  model?: string;
  fallbackModels?: string[];
  reasoningEffort?: string;
  timeoutMs?: number;
  maxRetriesPerModel?: number; // 0 disables same-model retry (probe mode)
  totalBudgetMs?: number;
  disableFallbacks?: boolean;
};

export class OpenAiLlmClient implements LlmClient {
  private readonly logger = new Logger(OpenAiLlmClient.name);
  private readonly client: OpenAI | null;
  private readonly model: string;
  private readonly fallbackModels: string[];
  private readonly reasoningEffort: string;
  private readonly timeoutMs: number;
  private readonly maxRetriesPerModel: number;
  private readonly totalBudgetMs: number;
  private readonly disableFallbacks: boolean;

  constructor(opts: OpenAiClientOptions = {}) {
    const env = getAppEnv();
    const useLegacyGemini = !env.OPENAI_API_KEY && Boolean(env.GEMINI_API_KEY);
    const apiKey = opts.apiKey ?? (env.OPENAI_API_KEY || env.GEMINI_API_KEY);
    const baseURL =
      opts.baseURL ?? (useLegacyGemini ? env.GEMINI_BASE_URL : undefined);
    this.model =
      opts.model ?? (useLegacyGemini ? env.GEMINI_MODEL : env.OPENAI_MODEL);
    const configuredFallbacks =
      opts.fallbackModels ??
      (useLegacyGemini
        ? env.GEMINI_FALLBACK_MODELS
        : env.OPENAI_FALLBACK_MODELS);
    const fallbackModels =
      configuredFallbacks.length > 0
        ? configuredFallbacks
        : !opts.fallbackModels && useLegacyGemini
          ? [DEFAULT_GEMINI_FALLBACK_MODEL]
          : [];
    this.fallbackModels = fallbackModels.filter((m) => m && m !== this.model);
    this.reasoningEffort = (
      opts.reasoningEffort ??
      (useLegacyGemini
        ? env.GEMINI_REASONING_EFFORT
        : env.OPENAI_REASONING_EFFORT)
    ).trim();
    this.timeoutMs =
      opts.timeoutMs ??
      (useLegacyGemini ? env.GEMINI_TIMEOUT_MS : env.OPENAI_TIMEOUT_MS);
    this.maxRetriesPerModel = opts.maxRetriesPerModel ?? 1; // one retry on same model for retryable errors
    this.totalBudgetMs =
      opts.totalBudgetMs ?? Math.max(8000, this.timeoutMs - 1000);
    this.disableFallbacks = opts.disableFallbacks ?? false;

    this.client = apiKey
      ? new OpenAI({
          apiKey,
          baseURL,
          timeout: this.timeoutMs,
          maxRetries: 0,
        })
      : null;
  }

  async createChatCompletion(params: {
    messages: LlmMessage[];
    tools?: LlmToolDefinition[];
    toolChoice?: 'auto' | 'none';
    temperature?: number;
    iteration?: number;
    reasoningEffort?: string;
  }): Promise<LlmCompletionResult> {
    if (!this.client) {
      throw new Error('LLM_NOT_CONFIGURED');
    }

    const iteration = params.iteration ?? 0;
    const startedAt = Date.now();
    const deadline = startedAt + this.totalBudgetMs;
    const models = this.disableFallbacks
      ? [this.model]
      : [this.model, ...this.fallbackModels];

    let reasoningEffort =
      params.reasoningEffort !== undefined
        ? params.reasoningEffort
        : this.reasoningEffort;
    if (reasoningEffort === '') reasoningEffort = '';
    let reasoningRetriedWithout = false;

    let lastError: unknown;

    for (let mi = 0; mi < models.length; mi++) {
      const model = models[mi];
      const attempts = this.maxRetriesPerModel + 1;
      for (let attempt = 0; attempt < attempts; attempt++) {
        const remaining = deadline - Date.now();
        if (remaining < 1500) {
          if (lastError) throw lastError;
          throw new Error('LLM_TIME_BUDGET_EXCEEDED');
        }

        const callStarted = Date.now();
        try {
          const req: any = {
            model,
            messages: this.normalizeMessages(params.messages),
            temperature: params.temperature ?? 0.3,
          };
          if (params.tools && params.tools.length > 0) {
            req.tools = params.tools;
            req.tool_choice = params.toolChoice ?? 'auto';
          } else if (params.toolChoice === 'none') {
            req.tool_choice = 'none';
          }
          if (reasoningEffort) {
            req.reasoning_effort = reasoningEffort;
          }

          const res = await this.client.chat.completions.create(req, {
            timeout: Math.min(this.timeoutMs, Math.max(1000, remaining - 200)),
          });
          const elapsedMs = Date.now() - callStarted;
          const msg = res.choices?.[0]?.message as any;
          this.logger.debug(
            `llm_ok model=${model} iteration=${iteration} elapsed_ms=${elapsedMs} tool_calls=${msg?.tool_calls?.length ?? 0}`,
          );
          return {
            model,
            elapsedMs,
            message: {
              role: 'assistant',
              content: (msg?.content as string | null | undefined) ?? null,
              tool_calls: msg?.tool_calls ?? undefined,
            },
          };
        } catch (e: any) {
          lastError = e;
          const elapsedMs = Date.now() - callStarted;
          const status = getStatus(e);
          const summary = errorSummary(e);
          this.logger.warn(
            `llm_fail model=${model} iteration=${iteration} status=${status} elapsed_ms=${elapsedMs} attempt=${attempt + 1}/${attempts}`,
          );

          // reasoning_effort unsupported: retry once without it, do not count as normal retry/fallback
          if (
            status === 400 &&
            reasoningEffort &&
            !reasoningRetriedWithout &&
            /reasoning/i.test(summary)
          ) {
            reasoningRetriedWithout = true;
            reasoningEffort = '';
            this.logger.warn(
              `llm_retry_without_reasoning_effort model=${model} iteration=${iteration} reason="400 mentions reasoning"`,
            );
            attempt--; // retry same model attempt slot
            continue;
          }

          const retryableTransient =
            status === 429 ||
            status === 'timeout' ||
            (typeof status === 'number' && status >= 500 && status <= 599);
          if (retryableTransient) {
            // A quota response will not improve by immediately repeating the same
            // request. Preserve the remaining request budget for the fallback model.
            if (mi < models.length - 1) break;
            if (attempt < attempts - 1 && deadline - Date.now() > 1200) {
              await sleep(jitter(700));
              continue;
            }
            // move to next fallback model
            break;
          }

          // 400/401/403/404 and other non-retryable: log clearly and throw
          throw e;
        }
      }
    }

    throw lastError ?? new Error('LLM_FAILED');
  }

  private normalizeMessages(messages: LlmMessage[]): any[] {
    return messages.map((m) => {
      if (m.role === 'assistant') {
        const hasToolCalls =
          Array.isArray(m.tool_calls) && m.tool_calls.length > 0;
        const msg: any = {
          role: 'assistant',
          content: hasToolCalls ? (m.content ?? null) : (m.content ?? ''),
        };
        if (hasToolCalls) {
          msg.tool_calls = m.tool_calls;
          // OpenAI compatible APIs may require null content when tool calls are present.
          if (msg.content === '') msg.content = null;
        }
        return msg;
      }
      if (m.role === 'tool') {
        return {
          role: 'tool',
          tool_call_id: m.tool_call_id,
          content: m.content,
        };
      }
      return { role: m.role, content: m.content };
    });
  }
}
