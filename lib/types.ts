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
  modalPlan: string | null;
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
