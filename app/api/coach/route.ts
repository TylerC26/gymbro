import { createClient } from "@supabase/supabase-js";
import { NextResponse } from "next/server";
import { appendMessages, loadState, seedRemote } from "@/lib/db";
import { buildSeed } from "@/lib/seed";
import { todayISO } from "@/lib/types";
import { buildContext, SYSTEM_PROMPT } from "@/lib/coach/context";
import { EXECUTORS, TOOLS, type ToolContext } from "@/lib/coach/tools";
import { chat, isMinimaxConfigured, MINIMAX_MODEL, MinimaxError, type ChatMessage } from "@/lib/minimax";

export const runtime = "nodejs";
export const maxDuration = 120;

/** Tool-calling rounds before we stop and make the model answer with what it has. */
const MAX_ROUNDS = 6;
/** Wall-clock budget for the loop, kept under maxDuration so we can always
 *  return a real reply (and the athlete's edits) instead of being killed. */
const DEADLINE_MS = 90_000;
/** Turns of transcript replayed to the model — Supabase holds the full history. */
const HISTORY_TURNS = 24;

export async function POST(req: Request) {
  if (!isMinimaxConfigured()) {
    return NextResponse.json(
      { error: "Coach is offline: MINIMAX_API_KEY isn't set on the server. Add it to .env.local (and to the Vercel project) and restart." },
      { status: 503 },
    );
  }

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anonKey) {
    return NextResponse.json({ error: "Supabase isn't configured on the server." }, { status: 503 });
  }

  const token = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  if (!token) return NextResponse.json({ error: "Not signed in." }, { status: 401 });

  let body: { message?: string; today?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Malformed request." }, { status: 400 });
  }

  const userMessage = (body.message ?? "").trim();
  if (!userMessage) return NextResponse.json({ error: "Empty message." }, { status: 400 });
  if (userMessage.length > 2000) return NextResponse.json({ error: "That message is too long." }, { status: 400 });

  /* The athlete's own clock decides what "today" means — the server may be in
   * another timezone entirely. */
  const today = /^\d{4}-\d{2}-\d{2}$/.test(body.today ?? "") ? body.today! : todayISO();

  /* Request-scoped client carrying the athlete's JWT: every read and write in
   * this request is filtered by the same RLS policies as the browser's. */
  const supabase = createClient(url, anonKey, {
    global: { headers: { Authorization: `Bearer ${token}` } },
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { data: userData, error: authError } = await supabase.auth.getUser(token);
  const userId = userData?.user?.id;
  if (authError || !userId) return NextResponse.json({ error: "Session expired — reload the app." }, { status: 401 });

  try {
    let state = await loadState(supabase, userId);
    if (!state) {
      await seedRemote(supabase, userId, buildSeed(today));
      state = await loadState(supabase, userId);
    }
    if (!state) return NextResponse.json({ error: "Could not read your training log." }, { status: 500 });

    const startPos = state.messages.length;
    const ctx: ToolContext = { supabase, userId, today, state };

    const messages: ChatMessage[] = [
      { role: "system", content: `${SYSTEM_PROMPT}\n\n----- ATHLETE DATA (live from the database) -----\n${buildContext(state, today)}` },
      ...state.messages.slice(-HISTORY_TURNS).map((m) => ({
        role: (m.from === "coach" ? "assistant" : "user") as ChatMessage["role"],
        content: m.text,
      })),
      { role: "user", content: userMessage },
    ];

    const actions: string[] = [];
    const started = Date.now();
    let reply = "";

    for (let round = 0; round < MAX_ROUNDS; round++) {
      const assistant = await chat(messages, TOOLS);
      messages.push(assistant);

      if (!assistant.tool_calls?.length) {
        reply = (assistant.content ?? "").trim();
        break;
      }

      for (const call of assistant.tool_calls) {
        const executor = EXECUTORS[call.function.name];
        let result: string;
        if (!executor) {
          result = `Error: no such tool "${call.function.name}".`;
        } else {
          try {
            const args = call.function.arguments ? JSON.parse(call.function.arguments) : {};
            const done = await executor(args, ctx);
            actions.push(done);
            result = `OK: ${done}`;
          } catch (err) {
            result = `Error: ${err instanceof Error ? err.message : String(err)}`;
          }
        }
        messages.push({ role: "tool", tool_call_id: call.id, name: call.function.name, content: result });
      }

      /* Out of rounds (or out of time) but the model still wants tools: refresh
       * its view of the data and require a written answer. */
      if (round === MAX_ROUNDS - 1 || Date.now() - started > DEADLINE_MS) {
        messages.push({
          role: "user",
          content: `[system] Your edits are saved. Current data:\n${buildContext(ctx.state, today)}\n\nStop calling tools and reply to me now.`,
        });
        const final = await chat(messages, []);
        reply = (final.content ?? "").trim();
        break;
      }
    }

    if (!reply) {
      reply = actions.length ? `Done — ${actions.join("; ")}.` : "I didn't catch that. Tell me what you'd like to change.";
    }

    await appendMessages(
      supabase,
      userId,
      [
        { from: "user", text: userMessage },
        { from: "coach", text: reply, actions: actions.length ? actions : undefined },
      ],
      startPos,
    );

    /* Return the re-read state so the client renders exactly what's stored. */
    const fresh = (await loadState(supabase, userId)) ?? ctx.state;
    return NextResponse.json({ reply, actions, state: fresh, model: MINIMAX_MODEL });
  } catch (err) {
    const message =
      err instanceof MinimaxError
        ? `MiniMax is unreachable right now (${err.message.slice(0, 160)}).`
        : err instanceof Error
          ? err.message
          : "Something went wrong.";
    console.error("[coach]", err);
    return NextResponse.json({ error: message }, { status: 502 });
  }
}
