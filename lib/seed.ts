import type { Exercise, PersistedState, Plan, RecordItem, Session, WeighIn } from "./types";
import { shiftISO } from "./types";

/* A fresh athlete gets a plausible PPL block built *around the day they open
 * the app*, so the calendar, progress chart and today's session are all live
 * from the first render — and every one of them is a row the coach can edit. */

const TEMPLATE: Record<Exclude<Plan, "rest">, { title: string; groups: string; ex: [string, number, number, number][] }> = {
  push: {
    title: "Push Day",
    groups: "Chest · Shoulders · Triceps",
    ex: [
      ["Barbell Bench Press", 4, 8, 60],
      ["Incline Dumbbell Press", 4, 10, 22],
      ["Cable Fly", 3, 12, 15],
      ["Overhead Press", 4, 8, 35],
      ["Triceps Pushdown", 3, 15, 25],
    ],
  },
  pull: {
    title: "Pull Day",
    groups: "Back · Biceps",
    ex: [
      ["Deadlift", 4, 5, 100],
      ["Weighted Pull-Up", 4, 8, 15],
      ["Barbell Row", 4, 10, 55],
      ["Lat Pulldown", 3, 12, 45],
      ["Face Pull", 3, 15, 20],
      ["Barbell Curl", 3, 12, 25],
    ],
  },
  legs: {
    title: "Leg Day",
    groups: "Quads · Hamstrings",
    ex: [
      ["Back Squat", 4, 8, 95],
      ["Romanian Deadlift", 4, 10, 70],
      ["Leg Press", 4, 12, 140],
      ["Leg Curl", 3, 12, 40],
      ["Calf Raise", 4, 15, 60],
    ],
  },
};

/** Push / Pull / Legs / Rest on a 4-day rotation, aligned so today is a push day. */
const CYCLE: Plan[] = ["push", "pull", "legs", "rest"];
const planFor = (offset: number) => CYCLE[((offset % 4) + 4) % 4];

const buildExercises = (plan: Plan, offset: number, done: boolean): Exercise[] => {
  if (plan === "rest") return [];
  /* Loads creep up ~2.5% per completed block so the history shows progression. */
  const blocks = Math.floor(Math.abs(Math.min(offset, 0)) / 4);
  const scale = 1 - blocks * 0.025;
  return TEMPLATE[plan].ex.map(([name, sets, reps, kg]) => ({
    name,
    sets: Array.from({ length: sets }, () => ({
      w: Math.max(2.5, Math.round((kg * scale) / 2.5) * 2.5),
      r: reps,
      d: done,
    })),
  }));
};

const RECORDS: [string, Exclude<Plan, "rest">, number, number[], string][] = [
  ["Bench Press", "push", 62.5, [57.5, 60, 60, 62.5], "Top single. +2.5 kg this block — bar speed still sharp."],
  ["Overhead Press", "push", 45, [42.5, 45, 45, 45], "Stalled two sessions. Deload 10% next week."],
  ["Incline DB Press", "push", 24, [20, 22, 22, 24], "Per dumbbell."],
  ["Deadlift", "pull", 120, [110, 115, 117.5, 120], "Belted over 100 kg. Grip is the limiter."],
  ["Barbell Row", "pull", 60, [52.5, 55, 57.5, 60], "Strict, no body english."],
  ["Weighted Pull-Up", "pull", 15, [7.5, 10, 12.5, 15], "Added to bodyweight."],
  ["Back Squat", "legs", 95, [85, 90, 90, 95], "High bar, below parallel."],
  ["Romanian Deadlift", "legs", 80, [70, 72.5, 77.5, 80], "3-second eccentric."],
  ["Leg Press", "legs", 160, [140, 150, 155, 160], "Full stack within reach."],
];

/** Build the starting dataset for a brand-new athlete, anchored on `today`. */
export function buildSeed(today: string): PersistedState {
  const sessions: Session[] = [];
  /* Four weeks back (history for the calendar + volume stats) → one week ahead. */
  for (let offset = -28; offset <= 7; offset++) {
    const plan = planFor(offset);
    const date = shiftISO(today, offset);
    const past = offset < 0;
    sessions.push({
      date,
      title: plan === "rest" ? "Rest" : TEMPLATE[plan].title,
      groups: plan === "rest" ? "Recovery day" : TEMPLATE[plan].groups,
      plan,
      completed: past && plan !== "rest",
      notes: "",
      exercises: buildExercises(plan, offset, past),
    });
  }

  const weighIns: WeighIn[] = [];
  for (let i = 6; i >= 0; i--) {
    /* 79.6 kg drifting down to 78.4 kg over six weeks. */
    weighIns.push({ date: shiftISO(today, -i * 7), kg: +(78.4 + i * 0.2).toFixed(1) });
  }

  const records: RecordItem[] = RECORDS.map(([name, plan, kg, hist, note]) => ({ name, plan, kg, hist, note }));

  return {
    sessions,
    records,
    weighIns,
    memory: {},
    messages: [
      {
        from: "coach",
        text: "I'm your coach — I can see every session, record and weigh-in in your log, and I can change any of them. Tell me what you want to train and I'll rewrite today's plan, move sessions around the calendar, or log a new PR.",
      },
    ],
  };
}
