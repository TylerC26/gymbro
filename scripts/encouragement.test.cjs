/* The line the coach pops up when a set is ticked. Pure and local, so it can be
 * checked exactly — the point of these is that the wording is never generic
 * when the log has something specific to say. */
const { encouragement } = require("../build/tooltest/encouragement");
const { scheme } = require("../build/tooltest/types");

let failures = 0;
const check = (label, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};

/** A session of `n` exercises × `per` sets, all at 60 kg × 8, none done. */
const build = (names, per) => ({
  date: "2026-07-22",
  title: "Push Day",
  groups: "Chest",
  plan: "push",
  completed: false,
  notes: "",
  exercises: names.map((name) => ({ name, sets: Array.from({ length: per }, () => ({ w: 60, r: 8, d: false })) })),
});

/** Mark the first `counts[i]` sets of exercise `i` as done. */
const tick = (s, counts) => {
  s.exercises.forEach((ex, i) => ex.sets.forEach((st, j) => { st.d = j < (counts[i] ?? 0); }));
  return s;
};

/* ---- an ordinary set in the middle of the work ---- */
let s = build(["Bench Press", "Overhead Press", "Triceps Pushdown"], 4);
tick(s, [2, 0, 0]);
let line = encouragement(s, 0, 1, []);
const bank = new Set();
for (let i = 0; i < 300; i++) bank.add(encouragement(s, 0, 1, []));
check("every ordinary line quotes a number off the screen", [...bank].every((l) => /\d/.test(l)), [...bank][0]);
check("no ordinary line claims the lift or the session is over", [...bank].every((l) => !/done|session/i.test(l)));
check("the bank has real variety", bank.size >= 5, `${bank.size} distinct lines`);

/* ---- avoiding a repeat of the previous line ---- */
const repeated = new Set();
for (let i = 0; i < 300; i++) repeated.add(encouragement(s, 0, 1, [], line));
check("never repeats the line it was told to avoid", !repeated.has(line), `${repeated.size} alternatives`);

/* ---- last set of an exercise ---- */
s = build(["Bench Press", "Overhead Press", "Triceps Pushdown"], 4);
tick(s, [4, 0, 0]);
line = encouragement(s, 0, 3, []);
check("last set of a lift calls the lift done", line.includes("Bench Press done, all 4 sets"), line);
check("last set of a lift counts what's left", line.includes("8 left in the session"), line);

/* ---- past their best on the lift ---- */
s = build(["Bench Press", "Overhead Press", "Triceps Pushdown"], 4);
tick(s, [2, 0, 0]);
s.exercises[0].sets[1].w = 85;
const records = [{ name: "Bench Press", plan: "push", kg: 80, hist: [75, 80], note: "" }];
line = encouragement(s, 0, 1, records);
check("a set over their record says so with both numbers", line.includes("85 kg") && line.includes("80 kg"), line);
check("a record set promises the update, never claims it", /I'll move the record/.test(line) && !/moved|updated/.test(line), line);
check("a set under their record stays ordinary", !/record|best/.test(encouragement(tick(s, [2, 2, 0]), 1, 1, records)));

/* Loose name matching — the plan says "Barbell Bench Press", the record is
 * kept as "Bench Press". */
s = build(["Barbell Bench Press", "Overhead Press"], 4);
tick(s, [2, 0]);
s.exercises[0].sets[1].w = 85;
check("matches a record whose name is looser than the plan's",
  encouragement(s, 0, 1, records).includes("85 kg"), encouragement(s, 0, 1, records));

/* ---- the closing sets of a session ---- */
s = build(["Bench Press", "Overhead Press"], 4);
tick(s, [2, 4]); /* the second lift is finished, 2 of 4 here → 2 left in the day */
line = encouragement(s, 0, 1, []);
check("two sets from the end it counts down the session", line.includes("2 sets left in the whole session"), line);

/* ---- the last set of the day ---- */
s = build(["Bench Press", "Overhead Press"], 4);
tick(s, [4, 4]);
line = encouragement(s, 1, 3, []);
check("the final set totals the volume", line.includes("3840 kg moved"), line);
check("the final set points at Finish", line.includes("Finish"), line);

/* ---- a torn-up session can't crash the pop ---- */
check("an out-of-range set falls back to something sayable", encouragement(s, 9, 9, []) === "Set logged.");

/* ---- the exercise subtitle ---- */
check("subtitle lists every set as kg then reps",
  scheme({ name: "Bench", sets: [{ w: 60, r: 8, d: true }, { w: 62.5, r: 8, d: false }, { w: 65, r: 6, d: false }] }) === "60/62.5/65 8/8/6");
check("subtitle of an empty lift is a dash", scheme({ name: "Bench", sets: [] }) === "—");

console.log(`\n${failures === 0 ? "all checks passed" : `${failures} check(s) failed`}`);
process.exit(failures ? 1 : 0);
