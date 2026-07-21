/* End-to-end check of the AI engine: sign in as a fresh anonymous athlete, send
 * the coach a message that requires a database write, then read the rows back
 * and prove the write actually happened.
 *
 *   npm run dev            # in one terminal
 *   node scripts/smoke-coach.mjs
 */
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";

const BASE = process.env.SMOKE_BASE_URL ?? "http://localhost:3000";

for (const file of [".env.local", ".env"]) {
  try {
    for (const line of readFileSync(new URL(`../${file}`, import.meta.url), "utf8").split("\n")) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
    }
  } catch { /* optional */ }
}

const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
if (!url || !anon) { console.error("Missing Supabase env vars."); process.exit(1); }

const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const today = iso(new Date());

const supabase = createClient(url, anon, { auth: { persistSession: false } });

const { data: auth, error: authErr } = await supabase.auth.signInAnonymously();
if (authErr) { console.error("Anonymous sign-in failed:", authErr.message); process.exit(1); }
const token = auth.session.access_token;
const userId = auth.user.id;
console.log(`athlete ${userId.slice(0, 8)}… signed in`);

let failures = 0;
const check = (label, ok, detail = "") => {
  console.log(`${ok ? "  PASS" : "  FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};

async function say(message) {
  const started = Date.now();
  const res = await fetch(`${BASE}/api/coach`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ message, today }),
  });
  const body = await res.json();
  const secs = ((Date.now() - started) / 1000).toFixed(1);
  if (!res.ok) throw new Error(`${res.status}: ${body.error ?? "unknown"}`);
  console.log(`\n> ${message}`);
  console.log(`coach (${secs}s): ${body.reply}`);
  (body.actions ?? []).forEach((a) => console.log(`  ✓ ${a}`));
  return body;
}

/** Read a day's exercises straight from Postgres — the source of truth. */
async function sessionOn(date) {
  const { data: w } = await supabase.from("workouts").select("*").eq("user_id", userId).eq("scheduled_date", date).maybeSingle();
  if (!w) return null;
  const { data: ex } = await supabase.from("workout_exercises").select("*").eq("workout_id", w.id).order("position");
  const { data: sets } = await supabase.from("exercise_sets").select("*").eq("user_id", userId);
  return {
    ...w,
    exercises: (ex ?? []).map((e) => ({
      name: e.name,
      sets: (sets ?? []).filter((s) => s.exercise_id === e.id).sort((a, b) => a.position - b.position),
    })),
  };
}

try {
  /* 1 — seeding + a plain read-only question. */
  const intro = await say("What's on for me today, and how has my volume trended this month?");
  check("coach answers with a non-empty reply", intro.reply.length > 10);
  check("state comes back with sessions", (intro.state?.sessions?.length ?? 0) > 0, `${intro.state?.sessions?.length} sessions`);

  /* 2 — a write to today's plan. */
  await say("Add lateral raises to today, 3 sets of 15 at 12 kg.");
  const t = await sessionOn(today);
  const lat = t?.exercises.find((e) => /lateral/i.test(e.name));
  check("lateral raise written to today's session", Boolean(lat), lat ? `${lat.sets.length} sets @ ${lat.sets[0]?.weight_kg}kg × ${lat.sets[0]?.reps}` : "not found");

  /* 3 — a relative load change. */
  const benchBefore = t?.exercises.find((e) => /bench/i.test(e.name))?.sets[0]?.weight_kg;
  await say("Add 2.5 kg to every bench press set today.");
  const t2 = await sessionOn(today);
  const benchAfter = t2?.exercises.find((e) => /bench/i.test(e.name))?.sets[0]?.weight_kg;
  check("bench load increased by 2.5 kg", Number(benchAfter) === Number(benchBefore) + 2.5, `${benchBefore} → ${benchAfter}`);

  /* 4 — a calendar write on a future date. */
  const future = iso(new Date(Date.now() + 3 * 86400000));
  await say(`Schedule a rest day on ${future}.`);
  const rest = await sessionOn(future);
  check("future day rescheduled as rest", rest?.plan === "rest", `plan=${rest?.plan}, title=${rest?.title}`);

  /* 5 — progress: a PR and a weigh-in. */
  await say("I hit a new deadlift PR of 125 kg today, and I weighed in at 77.2 kg.");
  const { data: recs } = await supabase.from("lift_records").select("*").eq("user_id", userId).ilike("name", "%deadlift%");
  check("deadlift record updated", Number(recs?.[0]?.current_kg) === 125, `current_kg=${recs?.[0]?.current_kg}`);
  const { data: bw } = await supabase.from("body_weight_logs").select("*").eq("user_id", userId).order("logged_at", { ascending: false }).limit(1);
  check("body weight logged", Number(bw?.[0]?.weight_kg) === 77.2, `weight_kg=${bw?.[0]?.weight_kg}`);

  /* 6 — durable memory. */
  await say("Remember that I train four days a week and I'm cutting to 75 kg.");
  const { data: mem } = await supabase.from("coach_memory").select("*").eq("user_id", userId);
  check("coach stored a durable fact", (mem?.length ?? 0) > 0, (mem ?? []).map((m) => `${m.key}=${m.value}`).join("; "));

  /* 7 — transcript persistence. */
  const { data: msgs } = await supabase.from("coach_messages").select("*").eq("user_id", userId).order("position");
  check("transcript persisted in order", (msgs?.length ?? 0) >= 12, `${msgs?.length} messages`);
  check("actions recorded on coach messages", (msgs ?? []).some((m) => Array.isArray(m.actions) && m.actions.length > 0));
} catch (err) {
  console.error("\nsmoke test aborted:", err.message);
  failures++;
}

console.log(`\n${failures === 0 ? "all checks passed" : `${failures} check(s) failed`}`);
process.exit(failures === 0 ? 0 : 1);
