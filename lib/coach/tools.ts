import type { SupabaseClient } from "@supabase/supabase-js";
import type { Exercise, LiftPlan, PersistedState, Plan, RecordItem, Session } from "../types";
import { PLAN_DEFAULTS, PLANS, shiftISO } from "../types";
import { deleteMemory, deleteSession, logBodyWeight, saveRecords, saveSession, saveSessions, setMemory } from "../db";
import type { ToolDef } from "../minimax";

/* The coach's hands. Every tool writes through the athlete's own RLS-scoped
 * client, mutates the in-memory working copy so later calls in the same turn
 * see the change, and returns a sentence the UI can show as proof of the edit. */

export interface ToolContext {
  supabase: SupabaseClient;
  userId: string;
  today: string;
  state: PersistedState;
}

/* ------------------------------------------------------------------ utils */

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));
const round = (n: number) => Math.round(n * 2) / 2; // gym plates land on 0.5 kg

/** Accepts an ISO date or the handful of relative words a model reaches for. */
function resolveDate(ctx: ToolContext, raw?: string | null): string {
  const v = (raw ?? "today").trim().toLowerCase();
  if (v === "today" || v === "") return ctx.today;
  if (v === "tomorrow") return shiftISO(ctx.today, 1);
  if (v === "yesterday") return shiftISO(ctx.today, -1);
  if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return v;
  throw new Error(`"${raw}" is not a date I can use. Pass YYYY-MM-DD, or "today"/"tomorrow"/"yesterday".`);
}

function requirePlan(raw?: string | null): Plan | undefined {
  if (!raw) return undefined;
  const v = raw.trim().toLowerCase();
  if ((PLANS as string[]).includes(v)) return v as Plan;
  throw new Error(`"${raw}" is not a valid plan. Use push, pull, legs or rest.`);
}

/** Loose name match so "bench" finds "Barbell Bench Press". */
function matchIndex(names: string[], query: string): number {
  const q = query.trim().toLowerCase();
  if (!q) return -1;
  let best = -1;
  let bestScore = 0;
  names.forEach((name, i) => {
    const n = name.toLowerCase();
    let score = 0;
    if (n === q) score = 100;
    else if (n.includes(q)) score = 50 + q.length;
    else {
      const qWords = q.split(/\s+/).filter((w) => w.length > 2);
      const hits = qWords.filter((w) => n.includes(w)).length;
      const back = n.split(/\s+/).filter((w) => w.length > 2 && q.includes(w)).length;
      score = hits * 10 + back * 4;
    }
    if (score > bestScore) { bestScore = score; best = i; }
  });
  return bestScore > 0 ? best : -1;
}

function getSession(ctx: ToolContext, date: string): Session | undefined {
  return ctx.state.sessions.find((s) => s.date === date);
}

/** Fetch the day, inventing an empty one when the athlete has nothing booked. */
function ensureSession(ctx: ToolContext, date: string, plan?: Plan): Session {
  const found = getSession(ctx, date);
  if (found) return found;
  const p = plan ?? "push";
  const created: Session = {
    date,
    plan: p,
    title: PLAN_DEFAULTS[p].title,
    groups: PLAN_DEFAULTS[p].groups,
    completed: false,
    notes: "",
    exercises: [],
  };
  ctx.state.sessions.push(created);
  ctx.state.sessions.sort((a, b) => a.date.localeCompare(b.date));
  return created;
}

async function persist(ctx: ToolContext, session: Session) {
  await saveSession(ctx.supabase, ctx.userId, session);
}

function buildSets(sets: number, reps: number, weight: number, previous?: Exercise): Exercise["sets"] {
  const n = clamp(Math.round(sets), 1, 12);
  return Array.from({ length: n }, (_, i) => ({
    w: clamp(round(weight), 0, 600),
    r: clamp(Math.round(reps), 1, 100),
    /* Keep ticks the athlete already earned when a set survives the edit. */
    d: previous?.sets[i]?.d ?? false,
  }));
}

const dayName = (ctx: ToolContext, date: string) =>
  date === ctx.today ? "today" : date === shiftISO(ctx.today, 1) ? "tomorrow" : date;

/* ------------------------------------------------------------------ tools */

type Args = Record<string, unknown>;
type Executor = (args: Args, ctx: ToolContext) => Promise<string>;

const str = (a: Args, k: string) => (typeof a[k] === "string" ? (a[k] as string) : undefined);
const nml = (a: Args, k: string) => {
  const v = a[k];
  if (v === undefined || v === null || v === "") return undefined;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : undefined;
};
const bool = (a: Args, k: string) => {
  const v = a[k];
  if (typeof v === "boolean") return v;
  if (v === "true") return true;
  if (v === "false") return false;
  return undefined;
};

export const TOOLS: ToolDef[] = [
  {
    type: "function",
    function: {
      name: "update_session",
      description:
        "Create or rewrite the training session on a calendar date. Use this to change today's plan, schedule a future workout, turn a day into a rest day, or mark a day complete. Passing `exercises` replaces the whole exercise list for that day; omit it to edit only the header fields.",
      parameters: {
        type: "object",
        properties: {
          date: { type: "string", description: "YYYY-MM-DD, or 'today'/'tomorrow'/'yesterday'. Defaults to today." },
          title: { type: "string", description: "e.g. 'Push Day', 'Upper Body', 'Rest'." },
          plan: { type: "string", enum: ["push", "pull", "legs", "rest"], description: "Split — drives the calendar dot colour." },
          groups: { type: "string", description: "Muscle groups subtitle, e.g. 'Chest · Shoulders · Triceps'." },
          notes: { type: "string", description: "Coaching notes attached to the day." },
          completed: { type: "boolean", description: "Mark the session as trained (fills its calendar dot)." },
          exercises: {
            type: "array",
            description: "Full replacement exercise list, in order.",
            items: {
              type: "object",
              properties: {
                name: { type: "string" },
                sets: { type: "number" },
                reps: { type: "number" },
                weight_kg: { type: "number" },
              },
              required: ["name"],
            },
          },
        },
        required: ["date"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "schedule_block",
      description:
        "Write a whole multi-week training block onto the calendar in one call. Use this whenever the athlete asks for a program, a block, or 'plan my next N weeks' — writing those days one at a time with update_session runs out of tool calls before the block is finished. `pattern` is ONE week of the cycle and repeats for `weeks` weeks.",
      parameters: {
        type: "object",
        properties: {
          start_date: { type: "string", description: "YYYY-MM-DD, or 'today'/'tomorrow'. The block's first day." },
          weeks: { type: "number", description: "How many times to repeat the pattern. 1–12." },
          pattern: {
            type: "array",
            description:
              "One week of the cycle, in order from start_date. Include the rest days too, so the rotation keeps lining up week after week.",
            items: {
              type: "object",
              properties: {
                plan: { type: "string", enum: ["push", "pull", "legs", "rest"] },
                title: { type: "string", description: "Defaults to the split's usual name." },
                groups: { type: "string", description: "Muscle groups subtitle." },
                notes: { type: "string" },
                exercises: {
                  type: "array",
                  description: "Omit or leave empty on rest days.",
                  items: {
                    type: "object",
                    properties: {
                      name: { type: "string" },
                      sets: { type: "number" },
                      reps: { type: "number" },
                      weight_kg: { type: "number", description: "Load in week 1." },
                      weekly_increment_kg: {
                        type: "number",
                        description: "Added to the load each week — typically 2.5 on upper compounds, 5 on lower, 0 for accessories.",
                      },
                    },
                    required: ["name"],
                  },
                },
              },
              required: ["plan"],
            },
          },
          overwrite: {
            type: "boolean",
            description:
              "Default false. If any day in the range already has a session, the call writes NOTHING and tells you which days clash — ask the athlete before calling again with true.",
          },
        },
        required: ["start_date", "weeks", "pattern"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "delete_session",
      description: "Remove the session on a date entirely, clearing it from the calendar.",
      parameters: {
        type: "object",
        properties: { date: { type: "string", description: "YYYY-MM-DD, or 'today'/'tomorrow'." } },
        required: ["date"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "add_exercise",
      description: "Append one exercise to a session (defaults to today's).",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string" },
          date: { type: "string", description: "Defaults to today." },
          sets: { type: "number", description: "Default 3." },
          reps: { type: "number", description: "Default 10." },
          weight_kg: { type: "number", description: "Default 20." },
          position: { type: "number", description: "0-based slot to insert at; appends by default." },
        },
        required: ["name"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "remove_exercise",
      description: "Drop an exercise from a session (defaults to today's).",
      parameters: {
        type: "object",
        properties: { name: { type: "string" }, date: { type: "string" } },
        required: ["name"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "update_exercise",
      description:
        "Change the load, rep target, set count or name of one exercise. Use weight_delta_kg / reps_delta for relative changes like 'add 2.5 kg'.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "Exercise to change — partial names match." },
          date: { type: "string", description: "Defaults to today." },
          new_name: { type: "string" },
          sets: { type: "number" },
          reps: { type: "number" },
          weight_kg: { type: "number", description: "Absolute load for every set." },
          weight_delta_kg: { type: "number", description: "Add (or subtract, if negative) from every set." },
          reps_delta: { type: "number" },
        },
        required: ["name"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "mark_sets",
      description:
        "Tick sets off as done (or un-tick them). Omit `exercise` to apply to the whole session — that is how you log a finished workout.",
      parameters: {
        type: "object",
        properties: {
          done: { type: "boolean", description: "true = completed." },
          exercise: { type: "string", description: "Omit for every exercise in the session." },
          date: { type: "string", description: "Defaults to today." },
          set_numbers: { type: "array", items: { type: "number" }, description: "1-based set numbers; omit for all sets." },
        },
        required: ["done"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "log_body_weight",
      description: "Record a weigh-in. Shows up on the Progress tab chart.",
      parameters: {
        type: "object",
        properties: {
          weight_kg: { type: "number" },
          date: { type: "string", description: "Defaults to today. One weigh-in per day — re-logging corrects it." },
        },
        required: ["weight_kg"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "upsert_record",
      description:
        "Set an athlete's lift record (PR) and push it onto that lift's history. Creates the record if it does not exist yet.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "Lift name, e.g. 'Bench Press'." },
          kg: { type: "number" },
          plan: { type: "string", enum: ["push", "pull", "legs"], description: "Required when creating a new record." },
          note: { type: "string", description: "Coaching note shown under the lift's chart." },
        },
        required: ["name", "kg"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "remember",
      description:
        "Store a durable fact about the athlete (goal, injury, schedule, equipment, preference) so it survives beyond this conversation.",
      parameters: {
        type: "object",
        properties: {
          key: { type: "string", description: "Short snake_case key, e.g. 'goal', 'injuries', 'training_days'." },
          value: { type: "string" },
        },
        required: ["key", "value"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "forget",
      description: "Delete a stored fact that is no longer true.",
      parameters: { type: "object", properties: { key: { type: "string" } }, required: ["key"] },
    },
  },
];

export const EXECUTORS: Record<string, Executor> = {
  async update_session(a, ctx) {
    const date = resolveDate(ctx, str(a, "date"));
    const plan = requirePlan(str(a, "plan"));
    const session = ensureSession(ctx, date, plan);
    const changes: string[] = [];

    if (plan && plan !== session.plan) {
      /* Switching split re-labels the day unless the caller named it too. */
      if (!str(a, "title") && session.title === PLAN_DEFAULTS[session.plan].title) session.title = PLAN_DEFAULTS[plan].title;
      if (!str(a, "groups") && session.groups === PLAN_DEFAULTS[session.plan].groups) session.groups = PLAN_DEFAULTS[plan].groups;
      session.plan = plan;
      changes.push(`split → ${plan}`);
    }
    const title = str(a, "title");
    if (title) { session.title = title; changes.push(`titled “${title}”`); }
    const groups = str(a, "groups");
    if (groups) { session.groups = groups; }
    const notes = str(a, "notes");
    if (notes !== undefined) { session.notes = notes; changes.push("notes updated"); }
    const completed = bool(a, "completed");
    if (completed !== undefined) { session.completed = completed; changes.push(completed ? "marked complete" : "marked not done"); }

    const raw = a.exercises;
    if (Array.isArray(raw)) {
      session.exercises = raw
        .filter((e): e is Args => Boolean(e) && typeof e === "object")
        .map((e) => {
          const name = String(e.name ?? "").trim();
          const previous = session.exercises.find((x) => x.name.toLowerCase() === name.toLowerCase());
          return {
            name,
            sets: buildSets(nml(e, "sets") ?? 3, nml(e, "reps") ?? 10, nml(e, "weight_kg") ?? previous?.sets[0]?.w ?? 20, previous),
          };
        })
        .filter((e) => e.name);
      changes.push(`${session.exercises.length} exercises set`);
    }

    await persist(ctx, session);
    return `${dayName(ctx, date)}: ${session.title}${changes.length ? ` (${changes.join(", ")})` : ""}`;
  },

  async schedule_block(a, ctx) {
    const start = resolveDate(ctx, str(a, "start_date"));
    const weeks = clamp(Math.round(nml(a, "weeks") ?? 4), 1, 12);

    const cycle = (Array.isArray(a.pattern) ? a.pattern : []).filter(
      (d): d is Args => Boolean(d) && typeof d === "object",
    );
    if (!cycle.length) throw new Error("`pattern` needs at least one day — one week of the cycle to repeat.");

    const dates = Array.from({ length: weeks * cycle.length }, (_, i) => shiftISO(start, i));

    /* ctx.state already holds every session the athlete has, so the clash check
     * costs no round trip. Refusing here — rather than trusting a prompt rule —
     * is what stops a new block from quietly flattening real logged history. */
    if (!bool(a, "overwrite")) {
      const clashes = dates.filter((d) => getSession(ctx, d));
      if (clashes.length) {
        const shown = clashes.slice(0, 5).join(", ");
        throw new Error(
          `${clashes.length} day(s) in that range already have sessions (${shown}${clashes.length > 5 ? "…" : ""}). ` +
            "Tell the athlete what would be replaced and get a yes, then call again with overwrite: true.",
        );
      }
    }

    const sessions: Session[] = dates.map((date, i) => {
      const day = cycle[i % cycle.length];
      const week = Math.floor(i / cycle.length);
      const exRaw = Array.isArray(day.exercises) ? day.exercises : [];
      /* A day with lifts but no split is a training day, not a rest day —
       * defaulting to "rest" here would silently throw its exercises away. */
      const plan = requirePlan(str(day, "plan")) ?? (exRaw.length ? "push" : "rest");
      return {
        date,
        plan,
        title: str(day, "title") ?? PLAN_DEFAULTS[plan].title,
        groups: str(day, "groups") ?? PLAN_DEFAULTS[plan].groups,
        notes: str(day, "notes") ?? "",
        completed: false,
        exercises:
          plan === "rest"
            ? []
            : exRaw
                .filter((e): e is Args => Boolean(e) && typeof e === "object")
                .map((e) => ({
                  name: String(e.name ?? "").trim(),
                  /* Week 1 load plus the per-week step; buildSets rounds to 0.5 kg. */
                  sets: buildSets(
                    nml(e, "sets") ?? 3,
                    nml(e, "reps") ?? 10,
                    (nml(e, "weight_kg") ?? 20) + (nml(e, "weekly_increment_kg") ?? 0) * week,
                  ),
                }))
                .filter((e) => e.name),
      };
    });

    await saveSessions(ctx.supabase, ctx.userId, sessions);

    /* Keep the working copy in step so later tools this turn see the new block. */
    const written = new Set(dates);
    ctx.state.sessions = [...ctx.state.sessions.filter((s) => !written.has(s.date)), ...sessions].sort((x, y) =>
      x.date.localeCompare(y.date),
    );

    const trained = sessions.filter((s) => s.exercises.length).length;
    return `scheduled ${weeks} week${weeks === 1 ? "" : "s"} from ${dayName(ctx, start)} — ${trained} training day${trained === 1 ? "" : "s"}, ${dates.length - trained} rest`;
  },

  async delete_session(a, ctx) {
    const date = resolveDate(ctx, str(a, "date"));
    if (!getSession(ctx, date)) throw new Error(`Nothing is scheduled on ${date}.`);
    await deleteSession(ctx.supabase, ctx.userId, date);
    ctx.state.sessions = ctx.state.sessions.filter((s) => s.date !== date);
    return `cleared ${dayName(ctx, date)} from the calendar`;
  },

  async add_exercise(a, ctx) {
    const date = resolveDate(ctx, str(a, "date"));
    const name = (str(a, "name") ?? "").trim();
    if (!name) throw new Error("An exercise name is required.");
    const session = ensureSession(ctx, date);
    const exercise: Exercise = {
      name,
      sets: buildSets(nml(a, "sets") ?? 3, nml(a, "reps") ?? 10, nml(a, "weight_kg") ?? 20),
    };
    const at = nml(a, "position");
    if (at !== undefined) session.exercises.splice(clamp(Math.round(at), 0, session.exercises.length), 0, exercise);
    else session.exercises.push(exercise);
    if (session.plan === "rest") session.plan = "push"; // a rest day with work on it isn't rest
    await persist(ctx, session);
    const s0 = exercise.sets[0];
    return `added ${name} ${exercise.sets.length} × ${s0.r} · ${s0.w} kg to ${dayName(ctx, date)}`;
  },

  async remove_exercise(a, ctx) {
    const date = resolveDate(ctx, str(a, "date"));
    const session = getSession(ctx, date);
    if (!session) throw new Error(`Nothing is scheduled on ${date}.`);
    const i = matchIndex(session.exercises.map((e) => e.name), str(a, "name") ?? "");
    if (i < 0) throw new Error(`No exercise matching "${str(a, "name")}" on ${date}. Present: ${session.exercises.map((e) => e.name).join(", ") || "none"}.`);
    const [removed] = session.exercises.splice(i, 1);
    await persist(ctx, session);
    return `removed ${removed.name} from ${dayName(ctx, date)}`;
  },

  async update_exercise(a, ctx) {
    const date = resolveDate(ctx, str(a, "date"));
    const session = getSession(ctx, date);
    if (!session) throw new Error(`Nothing is scheduled on ${date}.`);
    const i = matchIndex(session.exercises.map((e) => e.name), str(a, "name") ?? "");
    if (i < 0) throw new Error(`No exercise matching "${str(a, "name")}" on ${date}. Present: ${session.exercises.map((e) => e.name).join(", ") || "none"}.`);

    const ex = session.exercises[i];
    const changes: string[] = [];
    const newName = str(a, "new_name");
    if (newName) { changes.push(`renamed to ${newName}`); ex.name = newName; }

    const weight = nml(a, "weight_kg");
    const dW = nml(a, "weight_delta_kg");
    const reps = nml(a, "reps");
    const dR = nml(a, "reps_delta");
    const setCount = nml(a, "sets");

    if (weight !== undefined) { ex.sets.forEach((s) => { s.w = clamp(round(weight), 0, 600); }); changes.push(`${round(weight)} kg`); }
    else if (dW !== undefined) { ex.sets.forEach((s) => { s.w = clamp(round(s.w + dW), 0, 600); }); changes.push(`${dW >= 0 ? "+" : "−"}${Math.abs(dW)} kg`); }

    if (reps !== undefined) { ex.sets.forEach((s) => { s.r = clamp(Math.round(reps), 1, 100); }); changes.push(`${Math.round(reps)} reps`); }
    else if (dR !== undefined) { ex.sets.forEach((s) => { s.r = clamp(s.r + Math.round(dR), 1, 100); }); changes.push(`${dR >= 0 ? "+" : "−"}${Math.abs(Math.round(dR))} reps`); }

    if (setCount !== undefined) {
      const n = clamp(Math.round(setCount), 1, 12);
      const last = ex.sets[ex.sets.length - 1] ?? { w: 20, r: 10, d: false };
      ex.sets = Array.from({ length: n }, (_, k) => ex.sets[k] ?? { ...last, d: false });
      changes.push(`${n} sets`);
    }

    if (!changes.length) throw new Error("Nothing to change — pass a weight, reps, sets or new_name.");
    await persist(ctx, session);
    return `${ex.name} on ${dayName(ctx, date)}: ${changes.join(", ")}`;
  },

  async mark_sets(a, ctx) {
    const date = resolveDate(ctx, str(a, "date"));
    const session = getSession(ctx, date);
    if (!session) throw new Error(`Nothing is scheduled on ${date}.`);
    const done = bool(a, "done");
    if (done === undefined) throw new Error("`done` must be true or false.");

    const nums = Array.isArray(a.set_numbers)
      ? new Set(a.set_numbers.map((n) => Math.round(Number(n))).filter((n) => Number.isFinite(n)))
      : null;

    const query = str(a, "exercise");
    let targets = session.exercises;
    if (query) {
      const i = matchIndex(session.exercises.map((e) => e.name), query);
      if (i < 0) throw new Error(`No exercise matching "${query}" on ${date}.`);
      targets = [session.exercises[i]];
    }
    targets.forEach((ex) => ex.sets.forEach((s, j) => { if (!nums || nums.has(j + 1)) s.d = done; }));

    /* A day where everything is ticked is a day that was trained. */
    if (!query && !nums) session.completed = done;
    await persist(ctx, session);
    const what = query ? targets[0].name : "every exercise";
    return `${done ? "logged" : "un-logged"} ${what} on ${dayName(ctx, date)}`;
  },

  async log_body_weight(a, ctx) {
    const kg = nml(a, "weight_kg");
    if (kg === undefined || kg <= 0) throw new Error("A positive weight_kg is required.");
    const date = resolveDate(ctx, str(a, "date"));
    await logBodyWeight(ctx.supabase, ctx.userId, kg, date);
    ctx.state.weighIns = [...ctx.state.weighIns.filter((w) => w.date !== date), { date, kg }].sort((x, y) => x.date.localeCompare(y.date));
    return `logged ${kg} kg body weight on ${dayName(ctx, date)}`;
  },

  async upsert_record(a, ctx) {
    const name = (str(a, "name") ?? "").trim();
    const kg = nml(a, "kg");
    if (!name || kg === undefined) throw new Error("`name` and `kg` are required.");
    const note = str(a, "note");
    const plan = str(a, "plan")?.toLowerCase() as LiftPlan | undefined;

    const i = matchIndex(ctx.state.records.map((r) => r.name), name);
    let summary: string;
    let touched: RecordItem;
    if (i >= 0) {
      const r = ctx.state.records[i];
      const old = r.kg;
      r.kg = round(kg);
      r.hist = [...r.hist, round(kg)].slice(-6);
      if (note) r.note = note;
      if (plan && ["push", "pull", "legs"].includes(plan)) r.plan = plan;
      summary = `${r.name} record ${old} → ${r.kg} kg`;
      ctx.state.records.splice(i, 1);
      touched = r;
    } else {
      if (!plan || !["push", "pull", "legs"].includes(plan)) throw new Error(`"${name}" is a new record — pass plan as push, pull or legs.`);
      touched = { name, plan, kg: round(kg), hist: [round(kg)], note: note ?? "" };
      summary = `new ${name} record at ${touched.kg} kg`;
    }
    /* Front of the list = most recently touched. saveRecords renumbers position
     * from array order, so this is what makes the Progress tab surface the lifts
     * you are actually working on — there is no updated_at to sort by. */
    ctx.state.records.unshift(touched);
    await saveRecords(ctx.supabase, ctx.userId, ctx.state.records);
    return summary;
  },

  async remember(a, ctx) {
    const key = (str(a, "key") ?? "").trim().toLowerCase().replace(/\s+/g, "_");
    const value = (str(a, "value") ?? "").trim();
    if (!key || !value) throw new Error("`key` and `value` are required.");
    await setMemory(ctx.supabase, ctx.userId, key, value);
    ctx.state.memory[key] = value;
    return `remembered ${key}: ${value}`;
  },

  async forget(a, ctx) {
    const key = (str(a, "key") ?? "").trim().toLowerCase().replace(/\s+/g, "_");
    if (!key) throw new Error("`key` is required.");
    await deleteMemory(ctx.supabase, ctx.userId, key);
    delete ctx.state.memory[key];
    return `forgot ${key}`;
  },
};
