import type { RecordItem, Session } from "./types";

/* A line from the coach, shown for a couple of seconds when a set is ticked.
 *
 * These are written here rather than fetched from MiniMax on purpose: mid-set
 * the athlete is looking at the phone for about a second, and a round-trip to
 * the model would arrive after they'd put it down — and would push a message
 * into the transcript for every set of every session. So the wording is local
 * and instant, but the *content* is drawn from the same log the coach reads:
 * real loads, real counts, their actual record on the lift. */

/** How long a pop stays up, in ms. Matches the CSS animation length. */
export const POP_MS = 2600;

interface Facts {
  name: string;
  kg: number;
  reps: number;
  setNo: number;
  setsInExercise: number;
  leftInExercise: number;
  leftInSession: number;
}

/* Rotated at random for an ordinary set — the moments worth remarking on are
 * handled above, and this is just the coach acknowledging the work. Every one
 * carries a number off the screen: a pop that could have been written before
 * the athlete walked in reads as a slogan, not as their coach watching. */
const ORDINARY: ((f: Facts) => string)[] = [
  (f) => `Set ${f.setNo} down — ${f.kg} × ${f.reps}. ${f.leftInExercise} to go on ${f.name}.`,
  (f) => `${f.kg} × ${f.reps} banked. ${f.leftInExercise} left here.`,
  (f) => `That's ${f.setNo} of ${f.setsInExercise} on ${f.name}. Hold that form.`,
  (f) => `Logged. ${f.leftInExercise} more at ${f.kg} kg.`,
  (f) => `Good speed on that one. ${f.leftInExercise} to go.`,
  (f) => `${f.setNo} down, ${f.leftInExercise} to go. Breathe and reset.`,
  (f) => `Racked at ${f.kg} kg. Go again when you're ready.`,
];

/** The athlete's record for a lift, matched loosely — the plan may say
 *  "Barbell Bench Press" where the record is kept as "Bench Press". */
const findRecord = (records: RecordItem[], name: string) => {
  const n = name.toLowerCase();
  return (
    records.find((r) => r.name.toLowerCase() === n) ??
    records.find((r) => n.includes(r.name.toLowerCase()) || r.name.toLowerCase().includes(n))
  );
};

/**
 * What the coach says about the set just ticked off.
 *
 * `session` must be the state *after* the tick, so the counts describe what the
 * athlete has actually finished. `avoid` is the previous line, so the ordinary
 * ones don't repeat back to back.
 */
export const encouragement = (
  session: Session,
  exerciseIndex: number,
  setIndex: number,
  records: RecordItem[],
  avoid?: string | null,
): string => {
  const ex = session.exercises[exerciseIndex];
  const st = ex?.sets[setIndex];
  if (!ex || !st) return "Set logged.";

  const doneHere = ex.sets.filter((s) => s.d).length;
  const leftInExercise = ex.sets.length - doneHere;
  const allSets = session.exercises.reduce((n, e) => n + e.sets.length, 0);
  const doneSets = session.exercises.reduce((n, e) => n + e.sets.filter((s) => s.d).length, 0);
  const leftInSession = allSets - doneSets;

  /* Whole session on the floor. */
  if (leftInSession === 0) {
    const volume = session.exercises.reduce(
      (t, e) => t + e.sets.reduce((x, s) => x + (s.d ? s.w * s.r : 0), 0),
      0,
    );
    return `That's the session — ${Math.round(volume)} kg moved. Hit Finish and I'll log it.`;
  }

  /* Last set of this lift. */
  if (leftInExercise === 0) {
    return `${ex.name} done, all ${ex.sets.length} sets. ${leftInSession} left in the session.`;
  }

  /* Heavier than anything on the board for this lift. Careful with the tense:
   * the record only moves when the session is logged, and promising an edit
   * that hasn't happened is the one thing the coach must never do. */
  const rec = findRecord(records, ex.name);
  if (rec && st.w > rec.kg) {
    return `${st.w} kg on ${ex.name} — past your ${rec.kg} kg best. Finish the session and I'll move the record.`;
  }

  /* Nearly home. */
  if (leftInSession <= 2) {
    return `${leftInSession} ${leftInSession === 1 ? "set" : "sets"} left in the whole session. Close it out.`;
  }

  const facts: Facts = {
    name: ex.name,
    kg: st.w,
    reps: st.r,
    setNo: setIndex + 1,
    setsInExercise: ex.sets.length,
    leftInExercise,
    leftInSession,
  };
  const start = Math.floor(Math.random() * ORDINARY.length);
  for (let i = 0; i < ORDINARY.length; i++) {
    const line = ORDINARY[(start + i) % ORDINARY.length](facts);
    if (line !== avoid) return line;
  }
  return ORDINARY[start](facts);
};
