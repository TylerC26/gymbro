/* MiniMax is the app's AI engine. Its Chat Completions API is OpenAI-shaped,
 * so this is a thin typed fetch wrapper rather than a whole SDK dependency.
 * Docs: https://platform.minimax.io/docs/api-reference/text-chat-openai */

export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content?: string | null;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  name?: string;
}

export interface ToolDef {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

const BASE_URL = (process.env.MINIMAX_BASE_URL ?? "https://api.minimax.io/v1").replace(/\/$/, "");
export const MINIMAX_MODEL = process.env.MINIMAX_MODEL ?? "MiniMax-M2.1";

export const isMinimaxConfigured = () => Boolean(process.env.MINIMAX_API_KEY);

/** Reasoning models can leak their scratchpad into `content`; the UI only ever
 *  shows the answer. */
const stripThinking = (text: string) =>
  text.replace(/<think>[\s\S]*?<\/think>/gi, "").replace(/<\/?think>/gi, "").trim();

export class MinimaxError extends Error {}

export async function chat(
  messages: ChatMessage[],
  tools: ToolDef[],
  opts: { signal?: AbortSignal; temperature?: number } = {},
): Promise<ChatMessage> {
  const key = process.env.MINIMAX_API_KEY;
  if (!key) throw new MinimaxError("MINIMAX_API_KEY is not set");

  const res = await fetch(`${BASE_URL}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model: MINIMAX_MODEL,
      messages,
      /* Omitted entirely on the final turn — some deployments reject `tools: []`. */
      ...(tools.length ? { tools, tool_choice: "auto" } : {}),
      temperature: opts.temperature ?? 0.6,
      max_completion_tokens: 4096,
    }),
    signal: opts.signal ?? AbortSignal.timeout(45_000),
  });

  const raw = await res.text();
  if (!res.ok) throw new MinimaxError(`MiniMax ${res.status}: ${raw.slice(0, 500)}`);

  let body: {
    choices?: { message?: ChatMessage }[];
    base_resp?: { status_code?: number; status_msg?: string };
  };
  try {
    body = JSON.parse(raw);
  } catch {
    throw new MinimaxError(`MiniMax returned non-JSON: ${raw.slice(0, 200)}`);
  }

  /* MiniMax reports some failures with HTTP 200 and a base_resp envelope. */
  if (body.base_resp && body.base_resp.status_code) {
    throw new MinimaxError(`MiniMax ${body.base_resp.status_code}: ${body.base_resp.status_msg ?? "unknown error"}`);
  }

  const message = body.choices?.[0]?.message;
  if (!message) throw new MinimaxError("MiniMax returned no message");

  return {
    role: "assistant",
    content: typeof message.content === "string" ? stripThinking(message.content) : message.content ?? "",
    /* Some deployments send an empty array; normalise so `?.length` reads true only when real. */
    tool_calls: message.tool_calls?.length ? message.tool_calls : undefined,
  };
}
