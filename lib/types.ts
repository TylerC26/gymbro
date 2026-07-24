export type Tab = "today" | "progress" | "calendar" | "coach";
export type Plan = "push" | "pull" | "legs" | "rest";
/** Splits a lift record can belong to (a record is never a rest day). */
export type LiftPlan = Exclude<Plan, "rest">;

export interface SetEntry {
  w: number;
  r: number;
  d: boolean;
}
export interface Exercise {
  name: string;
  sets: SetEntry[];
}

/** One scheduled training day. `date` (ISO yyyy-mm-dd) is its identity — the
 *  Today tab, the Upcoming list and the calendar grid are all views of these. */
export interface Session {
  date: string;
  title: string;
  groups: string;
  plan: Plan;
  completed: boolean;
  notes: string;
  exercises: Exercise[];
}

export interface RecordItem {
  name: string;
  plan: LiftPlan;
  kg: number;
  hist: number[];
  note: string;
}
export interface Message {
  from: "coach" | "user";
  text: string;
  /** Human-readable summary of what this reply changed in the database. */
  actions?: string[];
}
export interface WeighIn {
  date: string;
  kg: number;
}

/** The slice of state that lives in Supabase. */
export interface PersistedState {
  sessions: Session[];
  records: RecordItem[];
  messages: Message[];
  weighIns: WeighIn[];
  memory: Record<string, string>;
}

export interface State extends PersistedState {
  tab: Tab;
  openEx: number;
  openRecord: string | null;
  draft: string;
  /** What's typed in the Today tab's weigh-in box, before it's logged. */
  weightDraft: string;
  modalPlan: string | null;
  /** A split the athlete has picked for a day that already holds lifts, held
   *  until they confirm replacing them. */
  pendingPlan: Plan | null;
  dragY: number;
  dragging: boolean;
  /** A coach turn is in flight (MiniMax is thinking / calling tools). */
  thinking: boolean;
}

export const PLAN_COLOR: Record<Plan, string> = {
  push: "#3c8cff",
  pull: "oklch(0.7 0.12 165)",
  legs: "oklch(0.72 0.13 55)",
  rest: "#d8d6cf",
};

export const PLANS: Plan[] = ["push", "pull", "legs", "rest"];

/** What a day is called before anyone has put lifts in it. Shared, so a day the
 *  athlete taps onto the calendar is titled exactly like one the coach writes. */
export const PLAN_DEFAULTS: Record<Plan, { title: string; groups: string }> = {
  push: { title: "Push Day", groups: "Chest · Shoulders · Triceps" },
  pull: { title: "Pull Day", groups: "Back · Biceps" },
  legs: { title: "Leg Day", groups: "Quads · Hamstrings" },
  rest: { title: "Rest", groups: "Recovery day" },
};

/* ------------------------------------------------------------------ dates
 * Everything is keyed on a local ISO date so "today" means the athlete's
 * today, not UTC's. */

export const toISO = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

export const todayISO = () => toISO(new Date());

/** Parse an ISO date as *local* midnight (`new Date("2026-07-21")` is UTC). */
export const fromISO = (iso: string) => {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(y, (m ?? 1) - 1, d ?? 1);
};

export const shiftISO = (iso: string, days: number) => {
  const d = fromISO(iso);
  d.setDate(d.getDate() + days);
  return toISO(d);
};

/* Mon-first, the way a training week is written out. */
const WEEK_ORDER = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

/** Memory key holding the split the athlete lays out for themselves. */
export const SELF_SCHEDULED_KEY = "self_scheduled_days";

/* Rides along on the stored value so the line reads as a fact in the system
 * prompt rather than a bare list. Parsing only ever takes the first two tokens
 * of each comma-separated entry, so this trails harmlessly and is re-attached
 * on every write. */
const SELF_SCHEDULED_NOTE = "— the athlete sets these days on the calendar themselves";

/** Fold a hand-set day into the athlete's stored pattern — "Mon push, Wed pull,
 *  Fri legs". The coach reads its memory as prose straight into the system
 *  prompt, so this stays a readable line rather than JSON. Rebuilt from the
 *  previous value every time, so setting a weekday twice corrects it instead of
 *  stacking up a second entry. */
export const withSelfScheduledDay = (current: string | undefined, iso: string, plan: Plan): string => {
  const byDay = new Map<string, string>();
  (current ?? "")
    .split(",")
    .map((part) => part.trim().split(/\s+/))
    .forEach(([day, p]) => {
      if (WEEK_ORDER.includes(day) && (PLANS as string[]).includes(p)) byDay.set(day, p);
    });
  byDay.set(WEEK_ORDER[(fromISO(iso).getDay() + 6) % 7], plan);
  const days = WEEK_ORDER.filter((d) => byDay.has(d)).map((d) => `${d} ${byDay.get(d)}`).join(", ");
  return `${days} ${SELF_SCHEDULED_NOTE}`;
};

const WEEKDAYS = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "TUE 22" — the compact label used in the upcoming list. */
export const shortLabel = (iso: string) => {
  const d = fromISO(iso);
  return `${WEEKDAYS[d.getDay()]} ${d.getDate()}`;
};

/** "Mon · 21 Jul" — the Today header. */
export const longLabel = (iso: string) => {
  const d = fromISO(iso);
  const wd = WEEKDAYS[d.getDay()];
  return `${wd[0]}${wd.slice(1).toLowerCase()} · ${d.getDate()} ${MONTHS[d.getMonth()]}`;
};

export const monthLabel = (iso: string) => {
  const d = fromISO(iso);
  return `${["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"][d.getMonth()]} ${d.getFullYear()}`;
};

/** Total kg lifted in a session, counting only sets ticked off. */
export const sessionVolume = (s: Session) =>
  s.exercises.reduce((t, ex) => t + ex.sets.reduce((x, st) => x + (st.d ? st.w * st.r : 0), 0), 0);

/** "62.5/62.5/65/65 8/8/6/6" — one entry per set, weights then reps, so every
 *  set is readable without opening the exercise. Derived, never stored. */
export const scheme = (ex: Exercise) => {
  if (!ex.sets.length) return "—";
  const weights = ex.sets.map((s) => s.w).join("/");
  const reps = ex.sets.map((s) => s.r).join("/");
  return `${weights} ${reps}`;
};

/** A session written out lift by lift with units and the heaviest set named:
 *
 *    1. Barbell Bench Press — 62.5kg × 8, 65kg × 6 (heaviest 65 kg)
 *    2. Dips — bodyweight × 12, bodyweight × 10 (bodyweight — no load to record)
 *
 *  Spelled out for the coach rather than left to be read back off the log. The
 *  heaviest set is the number lift records are written from, and asking a model
 *  to scan a set list for the top weight is asking it to get it wrong. A lift
 *  carrying no load says so in words: "heaviest 0 kg" reads as a number, and the
 *  coach would dutifully file a 0 kg record for it. */
export const describeTrained = (s: Session) =>
  s.exercises
    .map((ex, i) => {
      if (!ex.sets.length) return `${i + 1}. ${ex.name} — no sets`;
      const sets = ex.sets.map((st) => `${st.w ? `${st.w}kg` : "bodyweight"} × ${st.r}`).join(", ");
      const heaviest = ex.sets.reduce((m, st) => Math.max(m, st.w), 0);
      const top = heaviest > 0 ? `heaviest ${heaviest} kg` : "bodyweight — no load to record";
      return `${i + 1}. ${ex.name} — ${sets} (${top})`;
    })
    .join("\n");
