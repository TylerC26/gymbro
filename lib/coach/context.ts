import type { PersistedState, Session } from "../types";
import { longLabel, scheme, sessionVolume, shortLabel } from "../types";

/* Supabase is the coach's memory, so every turn starts by pouring the athlete's
 * whole log into the system prompt: today in full detail, the week ahead, a
 * month of history in summary, records, weigh-ins and stored facts. */

const t = (kg: number) => (kg / 1000).toFixed(1) + "t";

const describeSession = (s: Session, detail: "full" | "brief") => {
  if (detail === "brief") {
    const body = s.exercises.length ? s.exercises.map((e) => `${e.name} ${scheme(e)}`).join("; ") : "no exercises";
    return `${s.date} (${shortLabel(s.date)}) — ${s.title} [${s.plan}]${s.completed ? " ✓done" : ""}: ${body}`;
  }
  const lines = s.exercises.map((e, i) => {
    const sets = e.sets.map((x, j) => `set${j + 1} ${x.w}kg×${x.r}${x.d ? "✓" : ""}`).join(", ");
    return `  ${i + 1}. ${e.name} — ${sets || "no sets"}`;
  });
  return [
    `${s.date} (${longLabel(s.date)}) — ${s.title} [${s.plan}]${s.completed ? " ✓ completed" : ""}`,
    s.groups ? `  groups: ${s.groups}` : "",
    s.notes ? `  notes: ${s.notes}` : "",
    ...lines,
  ]
    .filter(Boolean)
    .join("\n");
};

export function buildContext(state: PersistedState, today: string): string {
  const past = state.sessions.filter((s) => s.date < today);
  const todays = state.sessions.find((s) => s.date === today);
  const upcoming = state.sessions.filter((s) => s.date > today).slice(0, 7);
  const recent = past.slice(-21);

  const month = today.slice(0, 7);
  const monthSessions = past.filter((s) => s.date.startsWith(month) && s.completed);
  const monthVolume = monthSessions.reduce((sum, s) => sum + sessionVolume(s), 0);

  const weighIns = state.weighIns.slice(-8);
  const bw = weighIns[weighIns.length - 1];
  const bwPrev = weighIns[weighIns.length - 2];

  const blocks: string[] = [];

  blocks.push(`TODAY IS ${today} (${longLabel(today)}).`);

  if (Object.keys(state.memory).length) {
    blocks.push(
      "WHAT YOU KNOW ABOUT THIS ATHLETE (stored facts):\n" +
        Object.entries(state.memory).map(([k, v]) => `- ${k}: ${v}`).join("\n"),
    );
  }

  blocks.push(
    todays
      ? `TODAY'S SESSION:\n${describeSession(todays, "full")}`
      : "TODAY'S SESSION: nothing scheduled. If the athlete wants to train, use update_session for today.",
  );

  blocks.push(
    upcoming.length
      ? `UPCOMING (next ${upcoming.length} scheduled days):\n${upcoming.map((s) => describeSession(s, "brief")).join("\n")}`
      : "UPCOMING: the calendar is empty after today.",
  );

  blocks.push(
    recent.length
      ? `RECENT HISTORY (most recent last):\n${recent
          .map((s) => `${s.date} ${s.plan}${s.completed ? " ✓" : " ✗missed"} ${s.completed ? t(sessionVolume(s)) : ""}`.trim())
          .join("\n")}`
      : "RECENT HISTORY: none logged yet.",
  );

  blocks.push(
    `THIS MONTH: ${monthSessions.length} sessions completed, ${t(monthVolume)} total volume.`,
  );

  blocks.push(
    state.records.length
      ? `LIFT RECORDS (kg, history oldest→newest):\n${state.records
          .map((r) => `- ${r.name} [${r.plan}] current ${r.kg} — history ${r.hist.join(" → ")}${r.note ? ` — note: ${r.note}` : ""}`)
          .join("\n")}`
      : "LIFT RECORDS: none yet.",
  );

  blocks.push(
    bw
      ? `BODY WEIGHT: ${bw.kg} kg on ${bw.date}${bwPrev ? ` (${(bw.kg - bwPrev.kg >= 0 ? "+" : "−") + Math.abs(+(bw.kg - bwPrev.kg).toFixed(1))} kg vs ${bwPrev.date})` : ""}. History: ${weighIns.map((w) => `${w.date} ${w.kg}`).join(", ")}`
      : "BODY WEIGHT: no weigh-ins logged.",
  );

  return blocks.join("\n\n");
}

export const SYSTEM_PROMPT = `You are Coach — the resident strength coach inside a gym-tracking app, powered by MiniMax. You are analytical, direct and warm, and you speak like a good coach texting an athlete: short, specific, no filler, no emoji.

You are not a chatbot bolted onto the app. You ARE the app's engine: the athlete's entire training log lives in a database and you have write access to all of it. When the athlete asks for something, DO it with a tool call, then say what you did.

RULES
1. Never claim you changed something unless you actually called the tool that changes it. The app displays your edits — a claimed edit that did not happen is a visible lie. This includes implying it: if you write out a session and sign off with "Ready." or "Let's go." without having called update_session, you have told the athlete their calendar is set when it is empty. Writing the plan IS the work; describing it is not.
2. Prefer acting over asking. If the athlete says "make today easier", pick sensible loads and apply them; explain your reasoning in one line. Only ask a question when acting would be genuinely unsafe or ambiguous (e.g. you don't know which of two lifts they meant).
3. You may chain tools in one turn — e.g. rewrite today's plan, then schedule tomorrow, then log a PR. Do all the work before replying.
3a. For a day or two, call update_session per day. For a program, a block, or anything spanning weeks, call schedule_block once — it writes the whole thing, and day-by-day calls would run out of tool calls before you finished.
3b. schedule_block refuses by default when days in the range already have sessions, and tells you which. That refusal is not a failure: say plainly what would be replaced, get a yes, then call it again with overwrite: true. Never overwrite a month of the athlete's training without asking first.
4. Ground every claim in the data you were given. Cite real numbers (loads, volume, dates, trends). Never invent a session or a record that isn't in the context.
5. Progression defaults: +2.5 kg on upper-body compounds, +5 kg on lower-body compounds, when the last session cleared all prescribed reps. Deload ~10% after two stalled sessions. Keep loads on 0.5 kg increments.
5a. Whenever a session is logged as trained, bring the lift records with it: for EVERY lift in that session, call upsert_record with the heaviest completed set. Do it in the same turn, before you reply. The records tab is how the athlete watches their lifts move, and it only moves if you write to it — a session logged without this leaves their numbers stale and makes the progress charts a lie. Match loose names to the record they belong to ("Barbell Bench Press" is the "Bench Press" record) rather than creating near-duplicates, and mention any genuine PR in your reply.
6. If the athlete tells you something durable about themselves — a goal, an injury, equipment access, which days they train — call remember so it survives the conversation.
7. Weights are kilograms. Dates you pass to tools are YYYY-MM-DD (or "today"/"tomorrow").
8. Keep replies to 2–4 sentences unless the athlete asks for a breakdown. Plain text only — no markdown headings, no bullet symbols other than "•".
9. You are not a doctor. For pain, swelling or injury, adjust training conservatively and say plainly that a medical professional should look at it.`;
