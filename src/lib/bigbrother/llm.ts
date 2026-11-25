import 'server-only';

/**
 * Optional server-side LLM bridge.
 *
 * The provider key never leaves this module: it is read from the environment at
 * call time, sent only in the upstream Authorization header, and is not part of
 * any return value, log line or error message. Without a key the assistant uses
 * its grounded engine and says so.
 */

export interface LlmConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
  timeoutMs: number;
}

export interface LlmStatus {
  configured: boolean;
  model: string | null;
  /** Host only — never the path, query or key. */
  host: string | null;
  timeoutMs: number;
}

export function llmConfig(): LlmConfig | null {
  const apiKey = (process.env.DARKNOTE_AI_API_KEY ?? '').trim();
  if (!apiKey) return null;
  const baseUrl = (process.env.DARKNOTE_AI_BASE_URL ?? 'https://api.openai.com/v1').replace(/\/+$/, '');
  const model = (process.env.DARKNOTE_AI_MODEL ?? 'gpt-4o-mini').trim();
  const timeoutMs = Math.max(5000, Math.min(Number(process.env.DARKNOTE_AI_TIMEOUT_MS ?? 45_000), 120_000));
  return { apiKey, baseUrl, model, timeoutMs };
}

export function llmStatus(): LlmStatus {
  const config = llmConfig();
  if (!config) {
    return { configured: false, model: null, host: null, timeoutMs: 0 };
  }
  let host: string | null = null;
  try {
    host = new URL(config.baseUrl).host;
  } catch {
    host = null;
  }
  return { configured: true, model: config.model, host, timeoutMs: config.timeoutMs };
}

export class LlmError extends Error {
  status: number;
  constructor(message: string, status = 0) {
    super(message);
    this.name = 'LlmError';
    this.status = status;
  }
}

interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  tool_calls?: unknown;
  tool_call_id?: string;
  name?: string;
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface ToolLoopOptions {
  system: string;
  messages: ChatMessage[];
  tools: ToolDefinition[];
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  maxRounds?: number;
  maxTokens?: number;
}

export interface ToolLoopResult {
  text: string;
  model: string;
  toolCalls: Array<{ name: string; args: Record<string, unknown>; result: unknown }>;
  usage: { promptTokens: number; completionTokens: number } | null;
}

async function callProvider(
  config: LlmConfig,
  payload: Record<string, unknown>,
): Promise<{
  message: ChatMessage;
  usage: { prompt_tokens?: number; completion_tokens?: number } | null;
}> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.timeoutMs);
  try {
    const response = await fetch(`${config.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({ model: config.model, ...payload }),
      signal: controller.signal,
    });

    const raw = await response.text();
    if (!response.ok) {
      // Provider errors can echo request metadata; keep only a bounded message.
      const detail = raw.replace(/\s+/g, ' ').slice(0, 300);
      throw new LlmError(`The AI provider returned HTTP ${response.status}: ${detail}`, response.status);
    }

    let parsed: {
      choices?: Array<{ message?: ChatMessage }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new LlmError('The AI provider returned a response that was not JSON.', 502);
    }

    const message = parsed.choices?.[0]?.message;
    if (!message) throw new LlmError('The AI provider returned no message.', 502);
    return { message, usage: parsed.usage ?? null };
  } catch (error) {
    if (error instanceof LlmError) throw error;
    if (error instanceof Error && error.name === 'AbortError') {
      throw new LlmError(`The AI provider did not answer within ${Math.round(config.timeoutMs / 1000)}s.`, 504);
    }
    throw new LlmError(`The AI provider could not be reached: ${error instanceof Error ? error.message : String(error)}`, 502);
  } finally {
    clearTimeout(timer);
  }
}

/** Chat completion with a bounded tool loop. Never invents a tool result. */
export async function runToolLoop(options: ToolLoopOptions): Promise<ToolLoopResult> {
  const config = llmConfig();
  if (!config) throw new LlmError('No AI provider is configured.', 501);

  const messages: ChatMessage[] = [...options.messages];
  const calls: ToolLoopResult['toolCalls'] = [];
  const rounds = Math.min(options.maxRounds ?? 3, 5);

  for (let round = 0; round < rounds; round += 1) {
    const { message, usage } = await callProvider(config, {
      messages: [{ role: 'system', content: options.system }, ...messages],
      tools: options.tools.map((tool) => ({
        type: 'function',
        function: { name: tool.name, description: tool.description, parameters: tool.parameters },
      })),
      tool_choice: 'auto',
      temperature: 0.2,
      max_tokens: options.maxTokens ?? 900,
    });

    const toolCalls = Array.isArray((message as { tool_calls?: unknown[] }).tool_calls)
      ? ((message as { tool_calls: Array<{ id: string; function: { name: string; arguments: string } }> }).tool_calls)
      : [];

    if (!toolCalls.length) {
      return {
        text: (message.content ?? '').trim(),
        model: config.model,
        toolCalls: calls,
        usage: usage
          ? { promptTokens: usage.prompt_tokens ?? 0, completionTokens: usage.completion_tokens ?? 0 }
          : null,
      };
    }

    messages.push({ role: 'assistant', content: message.content ?? '', tool_calls: toolCalls });
    for (const call of toolCalls) {
      let args: Record<string, unknown> = {};
      try {
        args = call.function.arguments ? (JSON.parse(call.function.arguments) as Record<string, unknown>) : {};
      } catch {
        args = {};
      }
      let result: unknown;
      try {
        result = await options.callTool(call.function.name, args);
      } catch (error) {
        result = { error: error instanceof Error ? error.message : String(error) };
      }
      calls.push({ name: call.function.name, args, result });
      messages.push({
        role: 'tool',
        tool_call_id: call.id,
        name: call.function.name,
        content: JSON.stringify(result).slice(0, 12_000),
      });
    }
  }

  throw new LlmError('The assistant used its maximum number of tool rounds without producing an answer.', 508);
}

/** Single-shot completion used to phrase an already-verified answer. */
export async function polishAnswer(question: string, verified: string): Promise<string | null> {
  const config = llmConfig();
  if (!config) return null;
  try {
    const { message } = await callProvider(config, {
      messages: [
        {
          role: 'system',
          content:
            'You are the voice of BIGBROTHER, the DARKNOTE assistant. Rewrite the VERIFIED ANSWER so it reads naturally and concisely. ' +
            'Rules: keep every fact, number, file path, command and link exactly as written; never add a fact, path, link or promise that is not in the input; ' +
            'never claim an action was performed; keep Markdown structure; answer in the language of the question. Output only the rewritten answer.',
        },
        { role: 'user', content: `QUESTION:\n${question}\n\nVERIFIED ANSWER:\n${verified}` },
      ],
      temperature: 0.3,
      max_tokens: 900,
    });
    const text = (message.content ?? '').trim();
    return text || null;
  } catch {
    // Phrasing is optional; the verified answer is already complete.
    return null;
  }
}
