import type { SupabaseClient } from "@supabase/supabase-js";
import { getSupabase } from "./supabaseClient";
import type { Exercise, Message, PersistedState, RecordItem, Session } from "./types";

/** The Today header is static in the UI, so we store constants for its row. */
const TODAY_META = { title: "Push Day", subtitle: "Chest · Shoulders · Triceps", date_label: "Mon · 21 Jul" };

const num = (v: unknown) => Number(v ?? 0);
const byPos = <T extends { position: number }>(a: T, b: T) => a.position - b.position;

/* ----------------------------------------------------------------- load */

/** Assemble the persisted state from the user's rows. Returns null when the
 *  user has no data yet (caller should seed). */
export async function loadRemoteState(userId: string): Promise<PersistedState | null> {
  const supabase = getSupabase();
  if (!supabase) return null;

  const [workoutsRes, exercisesRes, setsRes, recordsRes, recSessRes, messagesRes, bwRes] = await Promise.all([
    supabase.from("workouts").select("*").eq("user_id", userId),
    supabase.from("workout_exercises").select("*").eq("user_id", userId),
    supabase.from("exercise_sets").select("*").eq("user_id", userId),
    supabase.from("lift_records").select("*").eq("user_id", userId),
    supabase.from("lift_record_sessions").select("*").eq("user_id", userId),
    supabase.from("coach_messages").select("*").eq("user_id", userId),
    supabase.from("body_weight_logs").select("*").eq("user_id", userId).order("logged_at"),
  ]);

  const workouts = workoutsRes.data ?? [];
  if (workouts.length === 0) return null; // brand-new user → needs seeding

  const exercises = exercisesRes.data ?? [];
  const sets = setsRes.data ?? [];
  const records = recordsRes.data ?? [];
  const recSessions = recSessRes.data ?? [];
  const messages = messagesRes.data ?? [];
  const bw = bwRes.data ?? [];

  const exercisesOf = (workoutId: string) => exercises.filter((e) => e.workout_id === workoutId).sort(byPos);
  const setsOf = (exerciseId: string) => sets.filter((s) => s.exercise_id === exerciseId).sort(byPos);

  const todayW = workouts.find((w) => w.kind === "today");
  const workout: Exercise[] = todayW
    ? exercisesOf(todayW.id).map((e) => ({ name: e.name, sets: setsOf(e.id).map((s) => ({ w: num(s.weight_kg), r: s.reps, d: s.done })) }))
    : [];

  const plans: Session[] = workouts
    .filter((w) => w.kind === "upcoming")
    .sort(byPos)
    .map((w) => ({ date: w.date_label, title: w.title, groups: w.subtitle, color: w.color, ex: exercisesOf(w.id).map((e) => [e.name, e.scheme] as [string, string]) }));

  const recordItems: RecordItem[] = records
    .sort(byPos)
    .map((r) => ({ name: r.name, plan: r.plan, kg: num(r.current_kg), note: r.note, hist: recSessions.filter((x) => x.record_id === r.id).sort(byPos).map((x) => num(x.kg)) }));

  const messageItems: Message[] = messages.sort(byPos).map((m) => ({ from: m.sender, text: m.body }));

  let bodyWeight = 0, bodyWeightChange = 0;
  if (bw.length) {
    const last = num(bw[bw.length - 1].weight_kg);
    const prev = bw.length > 1 ? num(bw[bw.length - 2].weight_kg) : last;
    bodyWeight = last;
    bodyWeightChange = +(last - prev).toFixed(1);
  }

  return { workout, records: recordItems, plans, messages: messageItems, bodyWeight, bodyWeightChange };
}

/* --------------------------------------------------------------- inserts */

async function insertTodayWorkout(s: SupabaseClient, userId: string, workout: Exercise[]) {
  const { data: w } = await s.from("workouts").insert({ user_id: userId, kind: "today", ...TODAY_META, color: "", position: 0 }).select("id").single();
  if (!w) return;
  const exRows = workout.map((e, i) => ({ workout_id: w.id, user_id: userId, name: e.name, scheme: "", position: i }));
  if (!exRows.length) return;
  const { data: exIns } = await s.from("workout_exercises").insert(exRows).select("id,position");
  const idByPos = new Map((exIns ?? []).map((r) => [r.position, r.id]));
  const setRows: Record<string, unknown>[] = [];
  workout.forEach((e, i) => {
    const exId = idByPos.get(i);
    if (!exId) return;
    e.sets.forEach((st, j) => setRows.push({ exercise_id: exId, user_id: userId, position: j, weight_kg: st.w, reps: st.r, done: st.d }));
  });
  if (setRows.length) await s.from("exercise_sets").insert(setRows);
}

async function insertPlans(s: SupabaseClient, userId: string, plans: Session[]) {
  const wRows = plans.map((p, i) => ({ user_id: userId, kind: "upcoming", title: p.title, subtitle: p.groups, color: p.color, date_label: p.date, position: i }));
  if (!wRows.length) return;
  const { data: wIns } = await s.from("workouts").insert(wRows).select("id,position");
  const idByPos = new Map((wIns ?? []).map((r) => [r.position, r.id]));
  const exRows: Record<string, unknown>[] = [];
  plans.forEach((p, i) => {
    const wid = idByPos.get(i);
    if (!wid) return;
    p.ex.forEach((pair, j) => exRows.push({ workout_id: wid, user_id: userId, name: pair[0], scheme: pair[1], position: j }));
  });
  if (exRows.length) await s.from("workout_exercises").insert(exRows);
}

async function insertRecords(s: SupabaseClient, userId: string, records: RecordItem[]) {
  const rRows = records.map((r, i) => ({ user_id: userId, name: r.name, plan: r.plan, current_kg: r.kg, note: r.note, position: i }));
  if (!rRows.length) return;
  const { data: rIns } = await s.from("lift_records").insert(rRows).select("id,position");
  const idByPos = new Map((rIns ?? []).map((r) => [r.position, r.id]));
  const sRows: Record<string, unknown>[] = [];
  records.forEach((r, i) => {
    const rid = idByPos.get(i);
    if (!rid) return;
    r.hist.forEach((kg, j) => sRows.push({ record_id: rid, user_id: userId, position: j, kg }));
  });
  if (sRows.length) await s.from("lift_record_sessions").insert(sRows);
}

async function insertMessages(s: SupabaseClient, userId: string, messages: Message[]) {
  const rows = messages.map((m, i) => ({ user_id: userId, sender: m.from, body: m.text, position: i }));
  if (rows.length) await s.from("coach_messages").insert(rows);
}

/* ------------------------------------------------------------------ seed */

export async function seedRemote(userId: string, init: PersistedState) {
  const s = getSupabase();
  if (!s) return;
  const prev = +(init.bodyWeight - init.bodyWeightChange).toFixed(1); // reconstruct the previous weigh-in
  const base = Date.now();
  await Promise.all([
    insertTodayWorkout(s, userId, init.workout),
    insertPlans(s, userId, init.plans),
    insertRecords(s, userId, init.records),
    insertMessages(s, userId, init.messages),
    s.from("body_weight_logs").insert([
      { user_id: userId, weight_kg: prev, logged_at: new Date(base - 86400000).toISOString() },
      { user_id: userId, weight_kg: init.bodyWeight, logged_at: new Date(base).toISOString() },
    ]),
  ]);
}

/* --------------------------------------------------------- save (delete+reinsert)
 * Data is tiny, so each mutable group is replaced wholesale. Not transactional —
 * acceptable for a single-user personal tracker. */

export async function saveWorkout(userId: string, workout: Exercise[]) {
  const s = getSupabase();
  if (!s) return;
  await s.from("workouts").delete().eq("user_id", userId).eq("kind", "today");
  await insertTodayWorkout(s, userId, workout);
}

export async function saveRecords(userId: string, records: RecordItem[]) {
  const s = getSupabase();
  if (!s) return;
  await s.from("lift_records").delete().eq("user_id", userId);
  await insertRecords(s, userId, records);
}

export async function saveMessages(userId: string, messages: Message[]) {
  const s = getSupabase();
  if (!s) return;
  await s.from("coach_messages").delete().eq("user_id", userId);
  await insertMessages(s, userId, messages);
}

/** Body weight is append-only history: record a new weigh-in. */
export async function logBodyWeight(userId: string, weight: number) {
  const s = getSupabase();
  if (!s) return;
  await s.from("body_weight_logs").insert({ user_id: userId, weight_kg: weight });
}
