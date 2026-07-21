export type Tab = "today" | "progress" | "calendar" | "coach";
export type Plan = "push" | "pull" | "legs";

export interface SetEntry {
  w: number;
  r: number;
  d: boolean;
}
export interface Exercise {
  name: string;
  sets: SetEntry[];
}
export interface RecordItem {
  name: string;
  plan: Plan;
  kg: number;
  hist: number[];
  note: string;
}
export interface Session {
  date: string;
  title: string;
  groups: string;
  color: string;
  ex: [string, string][];
}
export interface Message {
  from: "coach" | "user";
  text: string;
}

/** The slice of state that is persisted (to Supabase or localStorage). */
export interface PersistedState {
  workout: Exercise[];
  records: RecordItem[];
  plans: Session[];
  messages: Message[];
  bodyWeight: number;
  bodyWeightChange: number;
}

export interface State extends PersistedState {
  tab: Tab;
  openEx: number;
  openRecord: string | null;
  draft: string;
  modalPlan: number | null;
  dragY: number;
  dragging: boolean;
  timerSec: number;
  timerRunning: boolean;
}
