/* Exercises every coach tool against an in-memory fake of the Supabase client,
 * so the AI's write logic is proven without needing the network. */
const { EXECUTORS, TOOLS } = require("../build/tooltest/coach/tools");
const { buildContext } = require("../build/tooltest/coach/context");
const { buildSeed } = require("../build/tooltest/seed");
const { todayISO, shiftISO } = require("../build/tooltest/types");

/** Chainable stub: records what was written, resolves like PostgREST does. */
function fakeClient() {
  const calls = [];
  const from = (table) => {
    const b = {
      _rows: null,
      insert(rows) { this._rows = Array.isArray(rows) ? rows : [rows]; calls.push({ table, op: "insert", rows: this._rows }); return this; },
      upsert(row) { calls.push({ table, op: "upsert", rows: [row] }); return this; },
      delete() { calls.push({ table, op: "delete" }); return this; },
      select() { return this; },
      eq() { return this; }, gte() { return this; }, lte() { return this; }, order() { return this; },
      in(col, values) { calls.push({ table, op: "in", col, values }); return this; },
      single() { return Promise.resolve({ data: { id: `${table}-1` }, error: null }); },
      then(res, rej) {
        const data = (this._rows ?? []).map((r, i) => ({ id: `${table}-${i}`, position: r.position ?? i, workout_id: r.workout_id }));
        return Promise.resolve({ data, error: null }).then(res, rej);
      },
    };
    return b;
  };
  return { from, _calls: calls };
}

const today = todayISO();
let failures = 0;
const check = (label, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};

function newCtx() {
  return { supabase: fakeClient(), userId: "u1", today, state: buildSeed(today) };
}
const sessionOn = (ctx, d) => ctx.state.sessions.find((s) => s.date === d);
const run = (name, args, ctx) => EXECUTORS[name](args, ctx);
async function expectThrow(label, fn, match) {
  try { await fn(); check(label, false, "no error thrown"); }
  catch (e) { check(label, match ? match.test(e.message) : true, e.message); }
}

(async () => {
  /* ---- schema sanity ---- */
  check("every declared tool has an executor", TOOLS.every((t) => typeof EXECUTORS[t.function.name] === "function"),
    `${TOOLS.length} tools`);
  check("no orphan executors", Object.keys(EXECUTORS).every((k) => TOOLS.some((t) => t.function.name === k)));

  /* ---- today's plan ---- */
  let ctx = newCtx();
  let msg = await run("add_exercise", { name: "Lateral Raise", sets: 3, reps: 15, weight_kg: 12 }, ctx);
  const lat = sessionOn(ctx, today).exercises.find((e) => e.name === "Lateral Raise");
  check("add_exercise appends to today", Boolean(lat) && lat.sets.length === 3 && lat.sets[0].w === 12 && lat.sets[0].r === 15, msg);
  check("add_exercise wrote to the database", ctx.supabase._calls.some((c) => c.table === "exercise_sets" && c.op === "insert"));

  const benchBefore = sessionOn(ctx, today).exercises.find((e) => /Bench/.test(e.name)).sets[0].w;
  msg = await run("update_exercise", { name: "bench", weight_delta_kg: 2.5 }, ctx);
  const benchAfter = sessionOn(ctx, today).exercises.find((e) => /Bench/.test(e.name)).sets[0].w;
  check("update_exercise matches 'bench' fuzzily and adds 2.5 kg", benchAfter === benchBefore + 2.5, `${benchBefore} → ${benchAfter}`);

  msg = await run("update_exercise", { name: "overhead", sets: 6, reps: 5 }, ctx);
  const ohp = sessionOn(ctx, today).exercises.find((e) => /Overhead/.test(e.name));
  check("update_exercise resizes sets and reps", ohp.sets.length === 6 && ohp.sets.every((s) => s.r === 5), msg);

  await expectThrow("update_exercise rejects an unknown lift", () => run("update_exercise", { name: "zercher squat" }, ctx), /No exercise matching/);
  await expectThrow("update_exercise rejects a no-op call", () => run("update_exercise", { name: "bench" }, ctx), /Nothing to change/);

  msg = await run("remove_exercise", { name: "Cable Fly" }, ctx);
  check("remove_exercise drops the lift", !sessionOn(ctx, today).exercises.some((e) => e.name === "Cable Fly"), msg);

  /* ---- logging a session ---- */
  ctx = newCtx();
  msg = await run("mark_sets", { done: true }, ctx);
  const t = sessionOn(ctx, today);
  check("mark_sets ticks the whole session and marks it trained",
    t.completed && t.exercises.every((e) => e.sets.every((s) => s.d)), msg);

  msg = await run("mark_sets", { done: false, exercise: "cable fly", set_numbers: [2, 3] }, ctx);
  const fly = sessionOn(ctx, today).exercises.find((e) => /Fly/.test(e.name));
  check("mark_sets un-ticks only the named sets", fly.sets[0].d && !fly.sets[1].d && !fly.sets[2].d, msg);

  /* ---- the calendar ---- */
  ctx = newCtx();
  const future = shiftISO(today, 9); // beyond the seeded window
  msg = await run("update_session", { date: future, plan: "legs", title: "Heavy Legs", exercises: [{ name: "Back Squat", sets: 5, reps: 3, weight_kg: 110 }] }, ctx);
  const f = sessionOn(ctx, future);
  check("update_session creates a brand-new calendar day",
    Boolean(f) && f.plan === "legs" && f.title === "Heavy Legs" && f.exercises[0].sets.length === 5, msg);

  msg = await run("update_session", { date: "tomorrow", plan: "rest" }, ctx);
  const tom = sessionOn(ctx, shiftISO(today, 1));
  check("update_session accepts relative dates and switches split", tom.plan === "rest", msg);
  check("switching split relabels the day", tom.title === "Rest", `title=${tom.title}`);

  /* Replacing the exercise list must not wipe ticks the athlete already earned. */
  await run("mark_sets", { done: true, exercise: "bench" }, ctx);
  await run("update_session", { date: "today", exercises: [{ name: "Barbell Bench Press", sets: 4, reps: 8, weight_kg: 65 }, { name: "Dips", sets: 3, reps: 12, weight_kg: 0 }] }, ctx);
  const rebuilt = sessionOn(ctx, today);
  check("update_session preserves completed sets for surviving lifts",
    rebuilt.exercises[0].sets.every((s) => s.d) && rebuilt.exercises[0].sets[0].w === 65, `${rebuilt.exercises.map((e) => e.name).join(", ")}`);

  msg = await run("delete_session", { date: future }, ctx);
  check("delete_session clears the day", !sessionOn(ctx, future), msg);
  await expectThrow("delete_session on an empty day errors", () => run("delete_session", { date: shiftISO(today, 40) }, ctx), /Nothing is scheduled/);
  await expectThrow("a malformed date is rejected", () => run("update_session", { date: "next thursday" }, ctx), /not a date/);

  /* ---- progress ---- */
  ctx = newCtx();
  msg = await run("upsert_record", { name: "deadlift", kg: 125 }, ctx);
  const dl = ctx.state.records.find((r) => r.name === "Deadlift");
  check("upsert_record updates an existing PR and its history", dl.kg === 125 && dl.hist[dl.hist.length - 1] === 125, msg);
  check("record history is capped", dl.hist.length <= 6, `${dl.hist.length} entries`);

  await expectThrow("a new record needs a split", () => run("upsert_record", { name: "Hip Thrust", kg: 100 }, ctx), /pass plan/);
  msg = await run("upsert_record", { name: "Hip Thrust", kg: 100, plan: "legs" }, ctx);
  check("upsert_record creates a new PR", ctx.state.records.some((r) => r.name === "Hip Thrust"), msg);

  /* The seed already logs a weigh-in for today, so re-logging must correct it
   * rather than stack a second entry on the same date. */
  const weighInsBefore = ctx.state.weighIns.length;
  await run("log_body_weight", { weight_kg: 77.2 }, ctx);
  await run("log_body_weight", { weight_kg: 77.4 }, ctx);
  const lastWeighIn = ctx.state.weighIns[ctx.state.weighIns.length - 1];
  check("log_body_weight keeps one weigh-in per day",
    ctx.state.weighIns.length === weighInsBefore && lastWeighIn.date === today && lastWeighIn.kg === 77.4,
    `${ctx.state.weighIns.length} weigh-ins, latest ${lastWeighIn.date} ${lastWeighIn.kg}kg`);

  await run("log_body_weight", { weight_kg: 79, date: shiftISO(today, -60) }, ctx);
  check("a back-dated weigh-in slots into the history in order",
    ctx.state.weighIns.length === weighInsBefore + 1 && ctx.state.weighIns[0].date === shiftISO(today, -60),
    `first ${ctx.state.weighIns[0].date}`);
  await expectThrow("log_body_weight rejects nonsense", () => run("log_body_weight", { weight_kg: 0 }, ctx), /positive/);

  /* ---- memory ---- */
  msg = await run("remember", { key: "Training Days", value: "Mon/Tue/Thu/Fri" }, ctx);
  check("remember normalises the key", ctx.state.memory.training_days === "Mon/Tue/Thu/Fri", msg);
  await run("forget", { key: "training_days" }, ctx);
  check("forget removes it", !("training_days" in ctx.state.memory));

  /* ---- multi-week blocks ---- */
  ctx = newCtx();
  const blockStart = shiftISO(today, 30); // clear of the seeded month
  const week = [
    { plan: "push", exercises: [{ name: "Bench Press", sets: 4, reps: 6, weight_kg: 50, weekly_increment_kg: 2.5 }] },
    { plan: "pull", exercises: [{ name: "Barbell Row", sets: 4, reps: 8, weight_kg: 50 }] },
    { plan: "rest" },
    { plan: "legs", exercises: [{ name: "Back Squat", sets: 4, reps: 5, weight_kg: 80, weekly_increment_kg: 5 }] },
    { plan: "rest" },
    { plan: "push", exercises: [{ name: "Overhead Press", sets: 4, reps: 6, weight_kg: 30, weekly_increment_kg: 2.5 }] },
    { plan: "rest" },
  ];
  msg = await run("schedule_block", { start_date: blockStart, weeks: 4, pattern: week }, ctx);
  const block = ctx.state.sessions.filter((s) => s.date >= blockStart);
  check("schedule_block writes every day of the block", block.length === 28, msg);
  check("the whole block is one bulk insert, not one per day",
    ctx.supabase._calls.filter((c) => c.table === "workouts" && c.op === "insert").length === 1);

  const wk1 = block.find((s) => s.date === blockStart).exercises[0];
  const wk4 = block.find((s) => s.date === shiftISO(blockStart, 21)).exercises[0];
  check("weekly_increment_kg progresses the load each week", wk1.sets[0].w === 50 && wk4.sets[0].w === 57.5,
    `${wk1.sets[0].w} → ${wk4.sets[0].w} kg`);
  const flat = block.find((s) => s.date === shiftISO(blockStart, 22)).exercises[0];
  check("no increment leaves the load flat", flat.sets[0].w === 50, `${flat.name} ${flat.sets[0].w} kg in week 4`);
  check("rest days carry no exercises", block.filter((s) => s.plan === "rest").every((s) => s.exercises.length === 0),
    `${block.filter((s) => s.plan === "rest").length} rest days`);
  check("the rotation holds across weeks", block[0].plan === "push" && block[7].plan === "push" && block[9].plan === "rest");

  /* A block landing on days that already exist must refuse — and write nothing. */
  ctx = newCtx();
  await expectThrow("schedule_block refuses to overwrite existing days",
    () => run("schedule_block", { start_date: today, weeks: 2, pattern: week }, ctx), /already have sessions/);
  check("a refused block writes nothing at all",
    !ctx.supabase._calls.some((c) => c.table === "workouts" && c.op === "insert"));

  msg = await run("schedule_block", { start_date: today, weeks: 1, pattern: week, overwrite: true }, ctx);
  check("overwrite: true replaces the clashing days", sessionOn(ctx, today).exercises[0].name === "Bench Press", msg);
  check("overwriting replaces rather than duplicates", ctx.state.sessions.filter((s) => s.date === today).length === 1);

  await expectThrow("an empty pattern is rejected",
    () => run("schedule_block", { start_date: blockStart, weeks: 2, pattern: [] }, newCtx()), /at least one day/);

  /* A day carrying lifts but no split must not be silently emptied as a rest day. */
  ctx = newCtx();
  await run("schedule_block", {
    start_date: blockStart, weeks: 1,
    pattern: [{ exercises: [{ name: "Hip Thrust", sets: 3, reps: 10, weight_kg: 45 }] }, { plan: "rest" }],
  }, ctx);
  const untitled = ctx.state.sessions.find((s) => s.date === blockStart);
  check("a day with lifts but no split keeps them", untitled.plan === "push" && untitled.exercises.length === 1,
    `${untitled.plan}, ${untitled.exercises.length} exercise(s)`);

  /* ---- context fed to the model ---- */
  ctx = newCtx();
  await run("remember", { key: "goal", value: "cut to 75 kg" }, ctx);
  const context = buildContext(ctx.state, today);
  check("context states today's date", context.includes(`TODAY IS ${today}`));
  check("context includes today's sets in detail", /Barbell Bench Press — set1 \d/.test(context));
  check("context includes upcoming days", context.includes("UPCOMING"));
  check("context includes history and volume", /RECENT HISTORY/.test(context) && /THIS MONTH: \d+ sessions/.test(context));
  check("context includes records with history", /Deadlift \[pull\] current 120 — history/.test(context));
  check("context includes body weight trend", /BODY WEIGHT: [\d.]+ kg/.test(context));
  check("context includes stored facts", context.includes("goal: cut to 75 kg"));
  check("context stays a reasonable size", context.length < 12000, `${context.length} chars`);

  console.log(`\n${failures === 0 ? "all checks passed" : `${failures} check(s) failed`}`);
  process.exit(failures ? 1 : 0);
})();
