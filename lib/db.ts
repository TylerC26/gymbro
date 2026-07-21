import type { SupabaseClient } from "@supabase/supabase-js";
import type { Exercise, LiftPlan, Message, PersistedState, Plan, RecordItem, Session, WeighIn } from "./types";
import { toISO } from "./types";

/* Every function takes the client explicitly: the browser passes its anon
 * client, the coach API route passes a request-scoped client carrying the
 * athlete's JWT. Both are constrained by the same RLS policies. */

const num = (v: unknown) => Number(v ?? 0);
const byPos = <T extends { position: number }>(a: T, b: T) => a.position - b.position;

/* ----------------------------------------------------------------- load */

/** Assemble the whole athlete state. Returns null for a brand-new user
 *  (no sessions yet), which tells the caller to seed. */
export async function loadState(s: SupabaseClient, userId: string): Promise<PersistedState | null> {
  const [workoutsRes, exercisesRes, setsRes, recordsRes, recSessRes, messagesRes, bwRes, memRes] = await Promise.all([
    s.from("workouts").select("*").eq("user_id", userId).order("scheduled_date"),
    s.from("workout_exercises").select("*").eq("user_id", userId),
    s.from("exercise_sets").select("*").eq("user_id", userId),
    s.from("lift_records").select("*").eq("user_id", userId),
    s.from("lift_record_sessions").select("*").eq("user_id", userId),
    s.from("coach_messages").select("*").eq("user_id", userId),
    s.from("body_weight_logs").select("*").eq("user_id", userId).order("logged_at"),
    s.from("coach_memory").select("*").eq("user_id", userId),
  ]);

  const workouts = (workoutsRes.data ?? []).filter((w) => w.scheduled_date);
  /* Only a truly untouched account gets seeded — an athlete who let the coach
   * clear their calendar must not have a month of history conjured back. */
  if (workouts.length === 0 && (messagesRes.data ?? []).length === 0) return null;

  const exercises = exercisesRes.data ?? [];
  const sets = setsRes.data ?? [];
  const setsOf = (exerciseId: string) => sets.filter((x) => x.exercise_id === exerciseId).sort(byPos);

  const sessions: Session[] = workouts
    .sort((a, b) => String(a.scheduled_date).localeCompare(String(b.scheduled_date)))
    .map((w) => ({
      date: String(w.scheduled_date),
      title: w.title ?? "",
      groups: w.subtitle ?? "",
      plan: (w.plan ?? "rest") as Plan,
      completed: Boolean(w.completed),
      notes: w.notes ?? "",
      exercises: exercises
        .filter((e) => e.workout_id === w.id)
        .sort(byPos)
        .map((e) => ({ name: e.name, sets: setsOf(e.id).map((x) => ({ w: num(x.weight_kg), r: x.reps, d: x.done })) })),
    }));

  const recSessions = recSessRes.data ?? [];
  const records: RecordItem[] = (recordsRes.data ?? []).sort(byPos).map((r) => ({
    name: r.name,
    plan: r.plan as LiftPlan,
    kg: num(r.current_kg),
    note: r.note ?? "",
    hist: recSessions.filter((x) => x.record_id === r.id).sort(byPos).map((x) => num(x.kg)),
  }));

  const messages: Message[] = (messagesRes.data ?? [])
    .sort(byPos)
    .map((m) => ({ from: m.sender, text: m.body, actions: Array.isArray(m.actions) && m.actions.length ? m.actions : undefined }));

  const weighIns: WeighIn[] = (bwRes.data ?? []).map((b) => ({ date: toISO(new Date(b.logged_at)), kg: num(b.weight_kg) }));

  const memory: Record<string, string> = {};
  (memRes.data ?? []).forEach((m) => { memory[m.key] = m.value; });

  return { sessions, records, messages, weighIns, memory };
}

/* ---------------------------------------------------------------- sessions */

/** Replace one calendar day wholesale. Deleting cascades to its exercises and
 *  sets, so this is idempotent — the coach can call it repeatedly for a date. */
export async function saveSession(s: SupabaseClient, userId: string, session: Session) {
  await s.from("workouts").delete().eq("user_id", userId).eq("scheduled_date", session.date);

  const { data: w, error } = await s
    .from("workouts")
    .insert({
      user_id: userId,
      kind: "session",
      scheduled_date: session.date,
      title: session.title,
      subtitle: session.groups,
      plan: session.plan,
      completed: session.completed,
      notes: session.notes,
      color: "",
      date_label: "",
      position: 0,
    })
    .select("id")
    .single();
  if (error || !w) throw new Error(error?.message ?? "could not save session");

  await insertExercises(s, userId, w.id, session.exercises);
}

async function insertExercises(s: SupabaseClient, userId: string, workoutId: string, exercises: Exercise[]) {
  if (!exercises.length) return;
  const { data: exIns, error } = await s
    .from("workout_exercises")
    .insert(exercises.map((e, i) => ({ workout_id: workoutId, user_id: userId, name: e.name, scheme: "", position: i })))
    .select("id,position");
  if (error) throw new Error(error.message);

  const idByPos = new Map((exIns ?? []).map((r) => [r.position, r.id]));
  const setRows: Record<string, unknown>[] = [];
  exercises.forEach((e, i) => {
    const exId = idByPos.get(i);
    if (!exId) return;
    e.sets.forEach((st, j) =>
      setRows.push({ exercise_id: exId, user_id: userId, position: j, weight_kg: st.w, reps: st.r, done: st.d }),
    );
  });
  if (setRows.length) {
    const { error: setErr } = await s.from("exercise_sets").insert(setRows);
    if (setErr) throw new Error(setErr.message);
  }
}

export async function deleteSession(s: SupabaseClient, userId: string, date: string) {
  await s.from("workouts").delete().eq("user_id", userId).eq("scheduled_date", date);
}

/* ----------------------------------------------------------------- records */

export async function saveRecords(s: SupabaseClient, userId: string, records: RecordItem[]) {
  await s.from("lift_records").delete().eq("user_id", userId);
  if (!records.length) return;
  const { data: rIns, error } = await s
    .from("lift_records")
    .insert(records.map((r, i) => ({ user_id: userId, name: r.name, plan: r.plan, current_kg: r.kg, note: r.note, position: i })))
    .select("id,position");
  if (error) throw new Error(error.message);

  const idByPos = new Map((rIns ?? []).map((r) => [r.position, r.id]));
  const rows: Record<string, unknown>[] = [];
  records.forEach((r, i) => {
    const rid = idByPos.get(i);
    if (!rid) return;
    r.hist.forEach((kg, j) => rows.push({ record_id: rid, user_id: userId, position: j, kg }));
  });
  if (rows.length) await s.from("lift_record_sessions").insert(rows);
}

/* ---------------------------------------------------------------- messages */

/** Append to the transcript. `startPos` is the current message count, so
 *  positions stay dense and ordered. */
export async function appendMessages(s: SupabaseClient, userId: string, messages: Message[], startPos: number) {
  if (!messages.length) return;
  await s.from("coach_messages").insert(
    messages.map((m, i) => ({
      user_id: userId,
      sender: m.from,
      body: m.text,
      actions: m.actions ?? [],
      position: startPos + i,
    })),
  );
}

/* ------------------------------------------------------------ body weight */

/** Append-only history: one weigh-in per day, so re-logging corrects today's. */
export async function logBodyWeight(s: SupabaseClient, userId: string, kg: number, date?: string) {
  const at = date ? new Date(`${date}T12:00:00`) : new Date();
  const dayStart = new Date(at); dayStart.setHours(0, 0, 0, 0);
  const dayEnd = new Date(at); dayEnd.setHours(23, 59, 59, 999);
  await s
    .from("body_weight_logs")
    .delete()
    .eq("user_id", userId)
    .gte("logged_at", dayStart.toISOString())
    .lte("logged_at", dayEnd.toISOString());
  await s.from("body_weight_logs").insert({ user_id: userId, weight_kg: kg, logged_at: at.toISOString() });
}

/* ------------------------------------------------------------------ memory */

export async function setMemory(s: SupabaseClient, userId: string, key: string, value: string) {
  await s
    .from("coach_memory")
    .upsert({ user_id: userId, key, value, updated_at: new Date().toISOString() }, { onConflict: "user_id,key" });
}

export async function deleteMemory(s: SupabaseClient, userId: string, key: string) {
  await s.from("coach_memory").delete().eq("user_id", userId).eq("key", key);
}

/* -------------------------------------------------------------------- seed */

export async function seedRemote(s: SupabaseClient, userId: string, init: PersistedState) {
  /* Bulk-inserted rather than looping saveSession: a seed is ~35 days of
   * history and one round trip per day makes first load crawl. */
  const { data: wIns, error } = await s
    .from("workouts")
    .insert(
      init.sessions.map((p, i) => ({
        user_id: userId,
        kind: "session",
        scheduled_date: p.date,
        title: p.title,
        subtitle: p.groups,
        plan: p.plan,
        completed: p.completed,
        notes: p.notes,
        color: "",
        date_label: "",
        position: i,
      })),
    )
    .select("id,position");
  if (error) throw new Error(error.message);

  const workoutIdByPos = new Map((wIns ?? []).map((r) => [r.position, r.id]));
  const exRows: Record<string, unknown>[] = [];
  init.sessions.forEach((p, i) => {
    const wid = workoutIdByPos.get(i);
    if (!wid) return;
    p.exercises.forEach((e, j) => exRows.push({ workout_id: wid, user_id: userId, name: e.name, scheme: "", position: j }));
  });

  if (exRows.length) {
    const { data: exIns, error: exErr } = await s.from("workout_exercises").insert(exRows).select("id,workout_id,position");
    if (exErr) throw new Error(exErr.message);
    const exIdByKey = new Map((exIns ?? []).map((r) => [`${r.workout_id}:${r.position}`, r.id]));
    const setRows: Record<string, unknown>[] = [];
    init.sessions.forEach((p, i) => {
      const wid = workoutIdByPos.get(i);
      if (!wid) return;
      p.exercises.forEach((e, j) => {
        const exId = exIdByKey.get(`${wid}:${j}`);
        if (!exId) return;
        e.sets.forEach((st, k) =>
          setRows.push({ exercise_id: exId, user_id: userId, position: k, weight_kg: st.w, reps: st.r, done: st.d }),
        );
      });
    });
    if (setRows.length) await s.from("exercise_sets").insert(setRows);
  }

  await saveRecords(s, userId, init.records);
  await appendMessages(s, userId, init.messages, 0);
  if (init.weighIns.length) {
    await s.from("body_weight_logs").insert(
      init.weighIns.map((w) => ({ user_id: userId, weight_kg: w.kg, logged_at: new Date(`${w.date}T12:00:00`).toISOString() })),
    );
  }
}
