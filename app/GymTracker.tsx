"use client";

import { useEffect, useRef, useState, type CSSProperties } from "react";
import type { Exercise, Plan, State } from "@/lib/types";
import { ensureUserId, isSupabaseConfigured } from "@/lib/supabaseClient";
import { loadRemoteState, logBodyWeight, saveMessages, saveRecords, saveWorkout, seedRemote } from "@/lib/db";

/* ------------------------------------------------------------------ *
 * Initial data (ported from the design source)
 * ------------------------------------------------------------------ */
const INITIAL: State = {
  tab: "today",
  openEx: 0,
  openRecord: null,
  bodyWeight: 78.4,
  bodyWeightChange: -1.2,
  records: [
    { name: "Bench Press", plan: "push", kg: 62.5, hist: [57.5, 60, 60, 62.5], note: "Top single. +2.5 kg this block — bar speed still sharp." },
    { name: "Overhead Press", plan: "push", kg: 45, hist: [42.5, 45, 45, 45], note: "Stalled two sessions. Deload 10% next week." },
    { name: "Incline DB Press", plan: "push", kg: 24, hist: [20, 22, 22, 24], note: "Per dumbbell." },
    { name: "Deadlift", plan: "pull", kg: 120, hist: [110, 115, 117.5, 120], note: "Belted over 100 kg. Grip is the limiter." },
    { name: "Barbell Row", plan: "pull", kg: 60, hist: [52.5, 55, 57.5, 60], note: "Strict, no body english." },
    { name: "Weighted Pull-Up", plan: "pull", kg: 15, hist: [7.5, 10, 12.5, 15], note: "Added to bodyweight." },
    { name: "Back Squat", plan: "legs", kg: 95, hist: [85, 90, 90, 95], note: "High bar, below parallel." },
    { name: "Romanian Deadlift", plan: "legs", kg: 80, hist: [70, 72.5, 77.5, 80], note: "3-second eccentric." },
    { name: "Leg Press", plan: "legs", kg: 160, hist: [140, 150, 155, 160], note: "Full stack within reach." },
  ],
  workout: [
    { name: "Barbell Bench Press", sets: [{ w: 60, r: 8, d: true }, { w: 60, r: 8, d: true }, { w: 62.5, r: 6, d: true }, { w: 62.5, r: 6, d: true }] },
    { name: "Incline Dumbbell Press", sets: [{ w: 22, r: 10, d: true }, { w: 22, r: 10, d: true }, { w: 22, r: 9, d: true }, { w: 22, r: 8, d: true }] },
    { name: "Cable Fly", sets: [{ w: 15, r: 12, d: false }, { w: 15, r: 12, d: false }, { w: 15, r: 12, d: false }] },
    { name: "Overhead Press", sets: [{ w: 35, r: 8, d: false }, { w: 35, r: 8, d: false }, { w: 35, r: 8, d: false }, { w: 35, r: 8, d: false }] },
    { name: "Triceps Pushdown", sets: [{ w: 25, r: 15, d: false }, { w: 25, r: 15, d: false }, { w: 25, r: 15, d: false }] },
  ],
  draft: "",
  modalPlan: null,
  dragY: 0,
  dragging: false,
  plans: [
    { date: "TUE 22", title: "Pull Day", groups: "Back · Biceps", color: "oklch(0.7 0.12 165)", ex: [["Deadlift", "4 × 5 · 100 kg"], ["Pull-Up", "4 × 8 · BW"], ["Barbell Row", "4 × 10 · 55 kg"], ["Lat Pulldown", "3 × 12 · 45 kg"], ["Face Pull", "3 × 15 · 20 kg"], ["Barbell Curl", "3 × 12 · 25 kg"]] },
    { date: "WED 23", title: "Leg Day", groups: "Quads · Hamstrings", color: "oklch(0.72 0.13 55)", ex: [["Back Squat", "4 × 8 · 95 kg"], ["Romanian Deadlift", "4 × 10 · 70 kg"], ["Leg Press", "4 × 12 · 140 kg"], ["Leg Curl", "3 × 12 · 40 kg"], ["Calf Raise", "4 × 15 · 60 kg"]] },
    { date: "THU 24", title: "Rest", groups: "Recovery day", color: "#d8d6cf", ex: [] },
  ],
  timerSec: 0,
  timerRunning: false,
  messages: [
    { from: "coach", text: "Morning. Your bench is trending up — 62.5 kg last session, a 2.5 kg PR. Want me to push today's top set?" },
    { from: "user", text: "Yeah let's try 65." },
    { from: "coach", text: "Good call. Data says you've cleared 4×8 at 60 twice, so 65 for 4×6 is a safe progression. I'll log it in today's plan." },
  ],
};

const STORAGE_KEY = "gymbro-state-v1";
const PLAN_COLOR: Record<Plan, string> = {
  push: "#3c8cff",
  pull: "oklch(0.7 0.12 165)",
  legs: "oklch(0.72 0.13 55)",
};

/* Calendar day cells for July 2026 (July 1 = Wednesday, Monday-first grid) */
const TRAINED: Record<number, Plan> = { 1: "push", 2: "pull", 4: "legs", 6: "push", 7: "pull", 9: "legs", 11: "push", 13: "pull", 14: "legs", 16: "push", 18: "pull", 20: "legs" };
interface DayCell { n: string; today: boolean; color: string; dot: string; weight: number; }
const DAYS: DayCell[] = (() => {
  const out: DayCell[] = [];
  for (let i = 0; i < 2; i++) out.push({ n: "", today: false, color: "transparent", dot: "transparent", weight: 400 });
  for (let n = 1; n <= 31; n++) {
    const today = n === 21;
    const plan = TRAINED[n];
    out.push({
      n: String(n),
      today,
      color: today ? "#fff" : "#12120f",
      weight: today ? 700 : 400,
      dot: today ? "#12120f" : plan ? PLAN_COLOR[plan] : "transparent",
    });
  }
  return out;
})();

const stepBtn: CSSProperties = { width: 24, height: 24, border: "1px solid #dcdad3", background: "#fff", borderRadius: 7, fontSize: 15, lineHeight: 1, color: "#12120f", cursor: "pointer", flex: "none" };
const hairline: CSSProperties = { height: 1, background: "rgba(0,0,0,.09)" };

/* ------------------------------------------------------------------ *
 * Component
 * ------------------------------------------------------------------ */
export default function GymTracker() {
  const [state, setS] = useState<State>(INITIAL);
  const timerRef = useRef<number | null>(null);
  const dy0 = useRef(0);
  const chatRef = useRef<HTMLDivElement>(null);

  /* setState with DCLogic-style merge semantics */
  const setState = (u: Partial<State> | ((s: State) => Partial<State>)) =>
    setS((prev) => ({ ...prev, ...(typeof u === "function" ? u(prev) : u) }));

  /* ---- persistence: Supabase (anonymous per-device) w/ localStorage fallback ---- */
  const userIdRef = useRef<string | null>(null);
  const hydratedRef = useRef(false);
  const skipNextSaveRef = useRef(false);
  const saveTimer = useRef<number | undefined>(undefined);

  const loadLocal = () => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) setState(JSON.parse(raw) as Partial<State>);
    } catch {
      /* ignore corrupt storage */
    }
  };

  // Hydrate once on mount: sign in anonymously, load rows (seeding a fresh user).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (isSupabaseConfigured) {
        const uid = await ensureUserId();
        if (uid && !cancelled) {
          userIdRef.current = uid;
          let data = await loadRemoteState(uid);
          if (!data) {
            await seedRemote(uid, INITIAL);
            data = await loadRemoteState(uid);
          }
          if (data && !cancelled) {
            skipNextSaveRef.current = true; // don't immediately re-save what we just loaded
            setState(data);
          }
        } else if (!cancelled) {
          loadLocal();
        }
      } else {
        loadLocal();
      }
      hydratedRef.current = true;
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Persist mutable state on change (debounced write-through to Supabase, else localStorage).
  useEffect(() => {
    if (!hydratedRef.current) return;
    const uid = userIdRef.current;
    if (isSupabaseConfigured && uid) {
      if (skipNextSaveRef.current) {
        skipNextSaveRef.current = false;
        return;
      }
      const { workout, records, messages } = state;
      window.clearTimeout(saveTimer.current);
      saveTimer.current = window.setTimeout(() => {
        saveWorkout(uid, workout);
        saveRecords(uid, records);
        saveMessages(uid, messages);
      }, 700);
    } else {
      try {
        const { workout, records, bodyWeight, bodyWeightChange, messages, plans } = state;
        localStorage.setItem(STORAGE_KEY, JSON.stringify({ workout, records, bodyWeight, bodyWeightChange, messages, plans }));
      } catch {
        /* storage full / unavailable */
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.workout, state.records, state.messages, state.bodyWeight, state.bodyWeightChange, state.plans]);

  /* ---- timer ---- */
  useEffect(() => () => { if (timerRef.current) clearInterval(timerRef.current); }, []);
  const toggleTimer = () => {
    if (state.timerRunning) {
      if (timerRef.current) clearInterval(timerRef.current);
      setState({ timerRunning: false });
    } else {
      timerRef.current = window.setInterval(() => setState((s) => ({ timerSec: s.timerSec + 1 })), 1000);
      setState({ timerRunning: true });
    }
  };

  /* ---- keep chat pinned to the latest message ---- */
  useEffect(() => {
    if (state.tab === "coach" && chatRef.current) chatRef.current.scrollTop = chatRef.current.scrollHeight;
  }, [state.messages, state.tab]);

  /* ---- workout editing ---- */
  const toggleOpen = (i: number) => setState((s) => ({ openEx: s.openEx === i ? -1 : i }));
  const adjustWeight = (ei: number, si: number, delta: number) =>
    setState((s) => ({ workout: s.workout.map((ex, i) => (i !== ei ? ex : { ...ex, sets: ex.sets.map((st, j) => (j !== si ? st : { ...st, w: Math.max(0, Math.round((st.w + delta) * 2) / 2) })) })) }));
  const adjustReps = (ei: number, si: number, delta: number) =>
    setState((s) => ({ workout: s.workout.map((ex, i) => (i !== ei ? ex : { ...ex, sets: ex.sets.map((st, j) => (j !== si ? st : { ...st, r: Math.max(1, st.r + delta) })) })) }));
  const toggleSet = (ei: number, si: number) =>
    setState((s) => ({ workout: s.workout.map((ex, i) => (i !== ei ? ex : { ...ex, sets: ex.sets.map((st, j) => (j !== si ? st : { ...st, d: !st.d })) })) }));

  /* ---- finish workout → coach summary ---- */
  const finish = () => {
    const w = state.workout;
    let vol = 0, setsDone = 0, totalSets = 0, exDone = 0;
    let top: { name: string; w: number; r: number } | null = null;
    w.forEach((ex) => {
      const nd = ex.sets.filter((x) => x.d);
      totalSets += ex.sets.length;
      setsDone += nd.length;
      if (nd.length === ex.sets.length) exDone++;
      nd.forEach((st) => {
        vol += st.w * st.r;
        if (!top || st.w > top.w) top = { name: ex.name, w: st.w, r: st.r };
      });
    });
    const volT = (vol / 1000).toFixed(1);
    let summary: string;
    if (setsDone === 0) {
      summary = "No sets logged yet — check off your sets on the Today tab, then hit Finish and I'll break down the numbers.";
    } else {
      const t = top as { name: string; w: number; r: number } | null;
      summary =
        "Session recorded. Here's the breakdown:\n\n" +
        "• Volume: " + volT + " t across " + setsDone + "/" + totalSets + " sets\n" +
        "• Exercises completed: " + exDone + "/" + w.length + "\n" +
        (t ? "• Heaviest working set: " + t.name + " at " + t.w + " kg × " + t.r + "\n\n" : "\n") +
        "Volume is up ~6% on your last push day. Recovery looks fine to progress the top bench set +2.5 kg next time.";
    }
    if (timerRef.current) clearInterval(timerRef.current);
    setState((s) => ({ tab: "coach", timerRunning: false, messages: [...s.messages, { from: "coach", text: summary }] }));
  };

  /* ---- coach send ---- */
  const send = () => {
    const raw = state.draft.trim();
    if (!raw) return;
    const reply = handle(raw);
    setState((s) => ({ draft: "", messages: [...s.messages, { from: "user", text: raw }, { from: "coach", text: reply }] }));
  };

  /* ---- fuzzy matching against the plan ---- */
  const findEx = (t: string) => {
    const alias: Record<string, string> = { bench: "Barbell Bench Press", incline: "Incline Dumbbell Press", fly: "Cable Fly", overhead: "Overhead Press", ohp: "Overhead Press", shoulder: "Overhead Press", triceps: "Triceps Pushdown", pushdown: "Triceps Pushdown" };
    let best = -1, score = 0;
    state.workout.forEach((e, i) => {
      let s = e.name.toLowerCase().split(/\s+/).filter((w) => w.length > 2 && t.includes(w)).length;
      Object.keys(alias).forEach((a) => { if (t.includes(a) && alias[a] === e.name) s += 2; });
      if (s > score) { score = s; best = i; }
    });
    return score > 0 ? best : -1;
  };
  const findRecord = (t: string) => {
    let best = -1, score = 0;
    state.records.forEach((r, i) => {
      const s = r.name.toLowerCase().split(/\s+/).filter((w) => w.length > 2 && t.includes(w)).length;
      if (s > score) { score = s; best = i; }
    });
    return score > 0 ? best : -1;
  };
  const patchEx = (i: number, fn: (e: Exercise) => Exercise) =>
    setState((s) => ({ workout: s.workout.map((e, k) => (k === i ? fn(e) : e)) }));

  /* ---- the natural-language coach ---- */
  const handle = (raw: string): string => {
    const t = " " + raw.toLowerCase() + " ";
    const firstNum = () => { const m = raw.match(/(\d+\.?\d*)/); return m ? parseFloat(m[1]) : null; };

    if (/\b(help|commands?|what can you do|how do)\b/.test(t))
      return "I can change anything in the app. Try:\n\n• \"set bench to 65 kg\"\n• \"add 2.5 kg to squat\"\n• \"make cable fly 4×15\"\n• \"overhead press 10 reps\"\n• \"mark triceps pushdown done\"\n• \"add lateral raise to today\"\n• \"log body weight 77.5\"\n• \"new deadlift PR 125\"";

    let m = raw.match(/(?:body\s*weight|bodyweight|weigh|scale)[^0-9]*(\d+\.?\d*)/i) || raw.match(/log\s+weight[^0-9]*(\d+\.?\d*)/i);
    if (m) {
      const w = parseFloat(m[1]), prev = state.bodyWeight, diff = +(w - prev).toFixed(1);
      setState({ bodyWeight: w, bodyWeightChange: diff });
      if (isSupabaseConfigured && userIdRef.current) logBodyWeight(userIdRef.current, w);
      const c = diff < 0 ? "Cut's on track — keep protein ≥1.8 g/kg." : diff > 0 ? "Trending up; fine if you're in a surplus." : "Holding steady.";
      return "Body weight logged: " + w + " kg (" + (diff >= 0 ? "+" : "−") + Math.abs(diff) + " kg vs last). " + c + " It's on your Progress tab.";
    }

    if (/\b(pr|record|1rm|max|personal best)\b/.test(t)) {
      const ri = findRecord(t), n = firstNum();
      if (ri >= 0 && n) {
        const r = state.records[ri], old = r.kg;
        setState((s) => ({ records: s.records.map((x, i) => (i === ri ? { ...x, kg: n, hist: [...x.hist.slice(1), n] } : x)) }));
        return "New " + r.name + " record: " + n + " kg (was " + old + "). A " + (n >= old ? "+" : "−") + Math.abs(+(n - old).toFixed(1)) + " kg move — I'll scale your working sets to ~80% of that.";
      }
    }

    const ei = findEx(t);
    if (ei >= 0) {
      const ex = state.workout[ei], name = ex.name;
      if (/\b(done|complete|completed|finished|log|logged|tick)\b/.test(t)) {
        patchEx(ei, (e) => ({ ...e, sets: e.sets.map((x) => ({ ...x, d: true })) }));
        return name + " marked complete — all " + ex.sets.length + " sets logged. Clean session.";
      }
      const rm = raw.match(/(\d+)\s*[x×]\s*(\d+)/i);
      if (rm) {
        const sets = parseInt(rm[1]), reps = parseInt(rm[2]), w = ex.sets[0] ? ex.sets[0].w : 20;
        patchEx(ei, (e) => ({ ...e, sets: Array.from({ length: sets }, (_, k) => (e.sets[k] ? { ...e.sets[k], r: reps } : { w, r: reps, d: false })) }));
        return "Updated " + name + " to " + sets + " × " + reps + ". Locked into today's plan.";
      }
      if (/\brep/.test(t)) { const n = firstNum(); if (n) { patchEx(ei, (e) => ({ ...e, sets: e.sets.map((x) => ({ ...x, r: Math.round(n) })) })); return "Set " + name + " to " + Math.round(n) + " reps per set."; } }
      if (/\b(add|increase|up|bump|raise)\b/.test(t)) { const n = firstNum(); if (n) { patchEx(ei, (e) => ({ ...e, sets: e.sets.map((x) => ({ ...x, w: Math.max(0, +(x.w + n).toFixed(1)) })) })); return "Added " + n + " kg to every " + name + " set. Progressive overload — hold your form."; } }
      if (/\b(reduce|drop|lower|decrease|deload)\b/.test(t)) { const n = firstNum(); if (n) { patchEx(ei, (e) => ({ ...e, sets: e.sets.map((x) => ({ ...x, w: Math.max(0, +(x.w - n).toFixed(1)) })) })); return "Dropped " + name + " by " + n + " kg per set. Smart fatigue management."; } }
      const n = firstNum();
      if (n !== null) { patchEx(ei, (e) => ({ ...e, sets: e.sets.map((x) => ({ ...x, w: n })) })); return name + " set to " + n + " kg across all sets. Updated on the Today tab."; }
      return "Found " + name + " in today's plan. Give me a weight, reps (e.g. 4×8), or say \"mark it done\".";
    }

    m = raw.match(/add\s+(.+?)\s+to\s+(?:today|the plan|plan|workout)/i);
    if (m) {
      const name = m[1].trim().replace(/\b\w/g, (c) => c.toUpperCase());
      const rm = raw.match(/(\d+)\s*[x×]\s*(\d+)/), wm = raw.match(/(\d+\.?\d*)\s*kg/i);
      const sets = rm ? parseInt(rm[1]) : 3, reps = rm ? parseInt(rm[2]) : 12, w = wm ? parseFloat(wm[1]) : 20;
      setState((s) => ({ workout: [...s.workout, { name, sets: Array.from({ length: sets }, () => ({ w, r: reps, d: false })) }] }));
      return "Added " + name + " to today — " + sets + " × " + reps + " at " + w + " kg. Adjust the load anytime.";
    }

    return "I've got your whole log. Volume's up ~6% this block and recovery looks fine. Tell me what to change — e.g. \"set bench to 65\", \"log body weight 77\", or \"mark cable fly done\". Type \"help\" for everything I can do.";
  };

  /* ---- modal (upcoming session) ---- */
  const openModal = (i: number) => setState({ modalPlan: i });
  const closeModal = () => setState({ modalPlan: null, dragY: 0, dragging: false });
  const dragStart = (e: React.PointerEvent<HTMLDivElement>) => { dy0.current = e.clientY; e.currentTarget.setPointerCapture?.(e.pointerId); setState({ dragging: true }); };
  const dragMove = (e: React.PointerEvent<HTMLDivElement>) => { if (!state.dragging) return; setState({ dragY: Math.max(0, e.clientY - dy0.current) }); };
  const dragEnd = () => { if (state.dragY > 90) closeModal(); else setState({ dragY: 0, dragging: false }); };
  const askCoach = () => {
    if (state.modalPlan === null) return;
    const p = state.plans[state.modalPlan];
    if (!p.ex.length) return;
    const ask = "Can you review my " + p.title + " (" + p.groups + ") plan?";
    const reply = p.title + " looks balanced. Starting with " + p.ex[0][0] + " is right — it's your heaviest compound while you're freshest. " +
      "Your last " + p.title.toLowerCase() + " hit RPE 8 on the top sets, so keep loads as prescribed and add 2.5 kg only if bar speed stays sharp. Rest 2–3 min on the first two lifts, 60–90 s on the rest.";
    setState((s) => ({ modalPlan: null, tab: "coach", messages: [...s.messages, { from: "user", text: ask }, { from: "coach", text: reply }] }));
  };

  /* ---- derived ---- */
  const doneCount = state.workout.filter((ex) => ex.sets.every((x) => x.d)).length;
  const timerLabel = Math.floor(state.timerSec / 60).toString().padStart(2, "0") + ":" + (state.timerSec % 60).toString().padStart(2, "0");
  const sign = (v: number) => (v >= 0 ? "+" : "−") + Math.abs(v);
  const modal = state.modalPlan !== null ? state.plans[state.modalPlan] : null;

  /* ================================================================ *
   * Render
   * ================================================================ */
  return (
    <div className="phone">
      <div className="screen">
        <div className="notch" />
        <div className="sbar">
          <span>9:41</span>
          <StatusIcons />
        </div>

        <div className="body">
          {/* ===================== TODAY ===================== */}
          {state.tab === "today" && (
            <div style={{ padding: "14px 26px 30px" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <div className="klabel">Mon · 21 Jul</div>
                <div style={{ width: 34, height: 34, borderRadius: "50%", background: "#e2e0da" }} />
              </div>
              <div style={{ display: "flex", alignItems: "flex-end", justifyContent: "space-between", gap: 12, margin: "20px 0 4px" }}>
                <h1 style={{ margin: 0, fontSize: 38, fontWeight: 800, lineHeight: 0.98, letterSpacing: "-.02em" }}>Push Day</h1>
                <button
                  onClick={toggleTimer}
                  style={{ display: "flex", alignItems: "center", gap: 7, border: `1px solid ${state.timerRunning ? "#3c8cff" : "#dcdad3"}`, background: state.timerRunning ? "#eaf2ff" : "#fff", color: state.timerRunning ? "#2d6fd0" : "#12120f", borderRadius: 12, padding: "7px 12px", cursor: "pointer", flex: "none", transform: "translateY(-3px)" }}
                >
                  <span style={{ width: 8, height: 8, borderRadius: "50%", background: state.timerRunning ? "#3c8cff" : "#c3c1b8" }} />
                  <span className="mono" style={{ fontSize: 16, fontWeight: 700, letterSpacing: ".02em" }}>{timerLabel}</span>
                </button>
              </div>
              <div style={{ fontSize: 15, color: "#6b6b64" }}>Chest · Shoulders · Triceps</div>
              <div className="mono" style={{ fontSize: 13, color: "#3c8cff", fontWeight: 600, marginTop: 4 }}>{doneCount} of {state.workout.length} done · ~52 min</div>
              <div style={{ ...hairline, margin: "22px -26px 0" }} />

              {state.workout.map((ex, i) => {
                const nsets = ex.sets.length;
                const ndone = ex.sets.filter((x) => x.d).length;
                const allDone = ndone === nsets;
                const open = state.openEx === i;
                return (
                  <div key={i} style={{ borderBottom: "1px solid rgba(0,0,0,.07)" }}>
                    <button onClick={() => toggleOpen(i)} style={{ display: "flex", alignItems: "center", gap: 14, padding: "18px 0", border: "none", background: "none", width: "100%", textAlign: "left", cursor: "pointer" }}>
                      <div className="mono" style={{ fontSize: 13, color: "#c3c1b8", width: 20 }}>{String(i + 1).padStart(2, "0")}</div>
                      <div style={{ flex: 1 }}>
                        <div style={{ fontSize: 17, fontWeight: 700, color: allDone ? "#9a9a92" : "#12120f" }}>{ex.name}</div>
                        <div className="mono" style={{ fontSize: 13, color: "#8a8a82", marginTop: 3 }}>{nsets} × {ex.sets[0].r} · {ex.sets[0].w} kg</div>
                      </div>
                      <div className="mono" style={{ fontSize: 12, color: "#3c8cff", fontWeight: 600 }}>{ndone}/{nsets}</div>
                      <div style={{ color: "#c3c1b8", fontSize: 14, transform: `rotate(${open ? 180 : 0}deg)`, transition: "transform .2s" }}>▾</div>
                    </button>
                    {open && (
                      <div style={{ padding: "2px 0 16px 34px", display: "flex", flexDirection: "column", gap: 2 }}>
                        <div className="klabel" style={{ display: "flex", alignItems: "center", gap: 10, paddingBottom: 4 }}>
                          <div style={{ width: 34, flex: "none" }} />
                          <div style={{ width: 114, textAlign: "center" }}>kg</div>
                          <div style={{ width: 104, textAlign: "center" }}>reps</div>
                          <div style={{ width: 22, marginLeft: "auto" }} />
                        </div>
                        {ex.sets.map((st, j) => (
                          <div key={j} style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 0" }}>
                            <div className="mono" style={{ fontSize: 12, color: "#9a9a92", width: 34, flex: "none" }}>Set {j + 1}</div>
                            <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
                              <button onClick={() => adjustWeight(i, j, -2.5)} style={stepBtn}>−</button>
                              <div className="mono" style={{ width: 56, textAlign: "center", whiteSpace: "nowrap", color: st.d ? "#9a9a92" : "#12120f", fontSize: 17, fontWeight: 700 }}>{st.w}</div>
                              <button onClick={() => adjustWeight(i, j, 2.5)} style={stepBtn}>+</button>
                            </div>
                            <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
                              <button onClick={() => adjustReps(i, j, -1)} style={stepBtn}>−</button>
                              <div className="mono" style={{ width: 46, textAlign: "center", whiteSpace: "nowrap", color: st.d ? "#9a9a92" : "#12120f", fontSize: 17, fontWeight: 700 }}>{st.r}</div>
                              <button onClick={() => adjustReps(i, j, 1)} style={stepBtn}>+</button>
                            </div>
                            <button onClick={() => toggleSet(i, j)} style={{ width: 22, height: 22, border: `2px solid ${st.d ? "#3c8cff" : "#d8d6cf"}`, background: st.d ? "#3c8cff" : "transparent", borderRadius: 6, display: "flex", alignItems: "center", justifyContent: "center", color: "#fff", fontSize: 12, cursor: "pointer", flex: "none", marginLeft: "auto" }}>{st.d ? "✓" : ""}</button>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
              <button className="btnp" style={{ marginTop: 24 }} onClick={finish}>Finish Workout</button>
            </div>
          )}

          {/* ===================== PROGRESS ===================== */}
          {state.tab === "progress" && (
            <div style={{ padding: "14px 26px 30px" }}>
              <div className="klabel">Progress</div>
              <h1 style={{ margin: "12px 0 20px", fontSize: 34, fontWeight: 800, letterSpacing: "-.02em" }}>This month</h1>
              <div style={{ display: "flex", borderTop: "1px solid rgba(0,0,0,.09)" }}>
                <div style={{ flex: 1, padding: "16px 0", borderRight: "1px solid rgba(0,0,0,.09)" }}>
                  <div className="mono" style={{ fontSize: 30, fontWeight: 700, letterSpacing: "-.02em" }}>14</div>
                  <div style={{ fontSize: 12, color: "#8a8a82" }}>workouts</div>
                </div>
                <div style={{ flex: 1, padding: "16px 0 16px 18px" }}>
                  <div className="mono" style={{ fontSize: 30, fontWeight: 700, letterSpacing: "-.02em" }}>48<span style={{ fontSize: 14 }}>t</span></div>
                  <div style={{ fontSize: 12, color: "#8a8a82" }}>total volume</div>
                </div>
              </div>
              <div style={hairline} />

              <div style={{ marginTop: 26 }} className="klabel">Body weight</div>
              <div style={{ display: "flex", alignItems: "baseline", gap: 8, margin: "8px 0 12px" }}>
                <div className="mono" style={{ fontSize: 26, fontWeight: 700 }}>{state.bodyWeight} kg</div>
                <div className="mono" style={{ fontSize: 13, color: "#3c8cff", fontWeight: 600 }}>{sign(state.bodyWeightChange)} kg</div>
              </div>
              <svg viewBox="0 0 300 90" style={{ width: "100%", height: 90, display: "block" }}>
                <polyline points="0,58 50,52 100,55 150,44 200,40 250,30 300,26" fill="none" stroke="#3c8cff" strokeWidth="2.5" strokeLinecap="round" />
                <circle cx="300" cy="26" r="4" fill="#3c8cff" />
              </svg>

              <div style={{ marginTop: 26, display: "flex", alignItems: "baseline", justifyContent: "space-between" }}>
                <span className="klabel">Lift records</span>
                <span className="mono" style={{ fontSize: 11, color: "#c3c1b8" }}>PPL split · tap to expand</span>
              </div>
              {([{ key: "push", label: "Push" }, { key: "pull", label: "Pull" }, { key: "legs", label: "Legs" }] as { key: Plan; label: string }[]).map((g) => {
                const color = PLAN_COLOR[g.key];
                return (
                  <div key={g.key}>
                    <div style={{ marginTop: 16, display: "flex", alignItems: "center", gap: 8 }}>
                      <span style={{ width: 9, height: 9, borderRadius: "50%", background: color }} />
                      <span className="klabel" style={{ color }}>{g.label}</span>
                    </div>
                    <div style={{ display: "flex", flexDirection: "column", marginTop: 2 }}>
                      {state.records.filter((r) => r.plan === g.key).map((r) => {
                        const open = state.openRecord === r.name;
                        const mx = Math.max(...r.hist), mn = Math.min(...r.hist), rng = mx - mn || 1;
                        const d = +(r.hist[r.hist.length - 1] - r.hist[0]).toFixed(1);
                        return (
                          <div key={r.name} style={{ borderBottom: "1px solid rgba(0,0,0,.07)" }}>
                            <button onClick={() => setState((s) => ({ openRecord: s.openRecord === r.name ? null : r.name }))} style={{ display: "flex", alignItems: "center", gap: 12, padding: "13px 0", border: "none", background: "none", width: "100%", textAlign: "left", cursor: "pointer" }}>
                              <div style={{ flex: 1, fontSize: 16, fontWeight: 700, color: open ? "#3c8cff" : "#12120f" }}>{r.name}</div>
                              <div className="mono" style={{ fontSize: 15, fontWeight: 600 }}>{r.kg} kg</div>
                              <div style={{ color: "#c3c1b8", fontSize: 13, transform: `rotate(${open ? 180 : 0}deg)`, transition: "transform .2s" }}>▾</div>
                            </button>
                            {open && (
                              <div style={{ padding: "2px 0 16px" }}>
                                <div style={{ display: "flex", alignItems: "flex-end", gap: 8, height: 52, marginBottom: 8 }}>
                                  {r.hist.map((v, idx) => {
                                    const isLast = idx === r.hist.length - 1;
                                    return (
                                      <div key={idx} style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "flex-end", gap: 5, height: "100%" }}>
                                        <span className="mono" style={{ fontSize: 10, color: isLast ? "#12120f" : "#a7a79f", fontWeight: 600 }}>{v}</span>
                                        <div style={{ width: "100%", background: isLast ? color : "#d8d6cf", borderRadius: 4, height: 12 + Math.round(((v - mn) / rng) * 30) }} />
                                      </div>
                                    );
                                  })}
                                </div>
                                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
                                  <span className="mono" style={{ fontSize: 11, color: "#9a9a92" }}>last 4 sessions (kg)</span>
                                  <span className="mono" style={{ fontSize: 11, color: "#3c8cff", fontWeight: 600 }}>{sign(d)} kg over 4</span>
                                </div>
                                <div style={{ fontSize: 13, color: "#6b6b64", marginTop: 6, lineHeight: 1.4 }}>{r.note}</div>
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  </div>
                );
              })}

              <div style={{ marginTop: 26 }} className="klabel">Progress photos</div>
              <div style={{ display: "flex", gap: 10, marginTop: 10 }}>
                <div className="strp" style={{ flex: 1, aspectRatio: "3/4", borderRadius: 14, display: "flex", alignItems: "flex-end", padding: 8 }}><span className="mono" style={{ fontSize: 9, color: "#8a8a82" }}>Jun 1</span></div>
                <div className="strp" style={{ flex: 1, aspectRatio: "3/4", borderRadius: 14, display: "flex", alignItems: "flex-end", padding: 8 }}><span className="mono" style={{ fontSize: 9, color: "#8a8a82" }}>Jul 1</span></div>
                <div style={{ flex: 1, aspectRatio: "3/4", borderRadius: 14, border: "2px dashed #cdcbc3", display: "flex", alignItems: "center", justifyContent: "center", color: "#b4b2aa", fontSize: 26 }}>+</div>
              </div>
            </div>
          )}

          {/* ===================== CALENDAR ===================== */}
          {state.tab === "calendar" && (
            <div style={{ padding: "14px 26px 30px" }}>
              <div className="klabel">Calendar</div>
              <h1 style={{ margin: "12px 0 20px", fontSize: 34, fontWeight: 800, letterSpacing: "-.02em" }}>July 2026</h1>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(7,1fr)", textAlign: "center" }}>
                {["M", "T", "W", "T", "F", "S", "S"].map((d, i) => (
                  <div key={i} className="mono" style={{ fontSize: 11, color: "#9a9a92", paddingBottom: 10 }}>{d}</div>
                ))}
                {DAYS.map((d, i) => (
                  <div key={i} style={{ aspectRatio: "1", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", position: "relative" }}>
                    <span className="mono" style={{ fontSize: 14, color: d.color, fontWeight: d.weight, width: 26, height: 26, display: "flex", alignItems: "center", justifyContent: "center", borderRadius: "50%", background: d.today ? "#12120f" : "transparent" }}>{d.n}</span>
                    <span style={{ width: 5, height: 5, borderRadius: "50%", background: d.dot, marginTop: 3 }} />
                  </div>
                ))}
              </div>
              <div style={{ ...hairline, margin: "20px -26px" }} />
              <div style={{ display: "flex", flexWrap: "wrap", gap: 14, fontSize: 12, color: "#8a8a82" }}>
                {([["Push", "#3c8cff"], ["Pull", "oklch(0.7 0.12 165)"], ["Legs", "oklch(0.72 0.13 55)"], ["Today", "#12120f"]] as [string, string][]).map(([label, c]) => (
                  <span key={label} style={{ display: "flex", alignItems: "center", gap: 6 }}><span style={{ width: 8, height: 8, borderRadius: "50%", background: c }} />{label}</span>
                ))}
              </div>
              <div className="klabel" style={{ marginTop: 24 }}>Upcoming</div>
              <div style={{ display: "flex", flexDirection: "column", marginTop: 6 }}>
                {state.plans.map((p, i) => {
                  const rest = p.ex.length === 0;
                  return (
                    <button key={i} onClick={() => !rest && openModal(i)} style={{ display: "flex", gap: 14, alignItems: "center", padding: "15px 0", border: "none", borderBottom: "1px solid rgba(0,0,0,.07)", background: "none", width: "100%", textAlign: "left", cursor: rest ? "default" : "pointer" }}>
                      <div className="mono" style={{ fontSize: 13, color: "#c3c1b8", width: 44, flex: "none" }}>{p.date}</div>
                      <div style={{ width: 6, height: 30, borderRadius: 4, background: p.color, flex: "none" }} />
                      <div style={{ flex: 1 }}>
                        <div style={{ fontSize: 16, fontWeight: 700, color: rest ? "#9a9a92" : "#12120f" }}>{p.title}</div>
                        <div className="mono" style={{ fontSize: 12, color: "#8a8a82" }}>{p.groups}</div>
                      </div>
                      <div style={{ color: "#c3c1b8", fontSize: 18 }}>{rest ? "" : "›"}</div>
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          {/* ===================== COACH ===================== */}
          {state.tab === "coach" && (
            <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
              <div style={{ padding: "14px 26px 16px", borderBottom: "1px solid rgba(0,0,0,.08)", flex: "none" }}>
                <div className="klabel">AI Coach</div>
                <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 8 }}>
                  <div className="mono" style={{ width: 36, height: 36, borderRadius: "50%", background: "#12120f", display: "flex", alignItems: "center", justifyContent: "center", color: "#3c8cff", fontWeight: 800 }}>C</div>
                  <div>
                    <div style={{ fontSize: 17, fontWeight: 800, lineHeight: 1 }}>Coach</div>
                    <div style={{ fontSize: 11, color: "#8a8a82" }}>Analytical · always on</div>
                  </div>
                </div>
              </div>
              <div ref={chatRef} style={{ flex: 1, overflowY: "auto", padding: "20px 22px", display: "flex", flexDirection: "column", gap: 14 }}>
                {state.messages.map((mmsg, i) => {
                  const coach = mmsg.from === "coach";
                  return (
                    <div key={i} style={{ alignSelf: coach ? "flex-start" : "flex-end", maxWidth: "80%", background: coach ? "#efedE7" : "#12120f", color: coach ? "#12120f" : "#fff", padding: "12px 15px", borderRadius: coach ? "4px 16px 16px 16px" : "16px 16px 4px 16px", fontSize: 14, lineHeight: 1.45, whiteSpace: "pre-line" }}>{mmsg.text}</div>
                  );
                })}
              </div>
              <div style={{ flex: "none", padding: "12px 18px 16px", borderTop: "1px solid rgba(0,0,0,.08)", display: "flex", gap: 10, alignItems: "center" }}>
                <input
                  value={state.draft}
                  onInput={(e) => setState({ draft: (e.target as HTMLInputElement).value })}
                  onKeyDown={(e) => { if (e.key === "Enter") send(); }}
                  placeholder="Try “set bench to 65” or “help”…"
                  style={{ flex: 1, minWidth: 0, border: "1px solid #dcdad3", borderRadius: 22, padding: "12px 16px", font: "400 14px var(--font-hanken)", background: "#fff", outline: "none" }}
                />
                <button onClick={send} style={{ width: 44, height: 44, borderRadius: "50%", background: "#12120f", color: "#fff", border: "none", fontSize: 18, cursor: "pointer", flex: "none" }}>↑</button>
              </div>
            </div>
          )}
        </div>

        {/* ===================== MODAL ===================== */}
        {modal && (
          <div onClick={closeModal} style={{ position: "absolute", inset: 0, zIndex: 50, background: "rgba(18,18,15,.42)", display: "flex", alignItems: "flex-end" }}>
            <div onClick={(e) => e.stopPropagation()} style={{ width: "100%", maxHeight: "82%", background: "#faf9f6", borderRadius: "26px 26px 38px 38px", padding: "0 26px 30px", overflowY: "auto", boxShadow: "0 -20px 50px -12px rgba(0,0,0,.35)", transform: `translateY(${state.dragY}px)`, transition: state.dragging ? "none" : "transform .25s ease" }}>
              <div onPointerDown={dragStart} onPointerMove={dragMove} onPointerUp={dragEnd} style={{ padding: "12px 0 8px", cursor: "grab", touchAction: "none" }}>
                <div style={{ width: 40, height: 5, borderRadius: 3, background: "#dcdad3", margin: "0 auto 10px" }} />
              </div>
              <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12 }}>
                <div>
                  <div className="klabel">{modal.date}</div>
                  <h2 style={{ margin: "6px 0 3px", fontSize: 30, fontWeight: 800, letterSpacing: "-.02em" }}>{modal.title}</h2>
                  <div style={{ fontSize: 14, color: "#6b6b64" }}>{modal.groups}</div>
                </div>
                <button onClick={askCoach} style={{ display: "flex", alignItems: "center", gap: 6, height: 34, padding: "0 13px", borderRadius: 17, border: "none", background: "#12120f", color: "#fff", font: "600 13px var(--font-hanken)", cursor: "pointer", flex: "none" }}><span style={{ color: "#3c8cff" }}>✦</span>Ask Coach</button>
              </div>
              <div className="mono" style={{ fontSize: 13, color: "#3c8cff", fontWeight: 600, marginTop: 6 }}>{modal.ex.length} exercises</div>
              <div style={{ ...hairline, margin: "16px -26px 0" }} />
              {modal.ex.map((e, i) => (
                <div key={i} style={{ display: "flex", alignItems: "baseline", gap: 14, padding: "16px 0", borderBottom: "1px solid rgba(0,0,0,.07)" }}>
                  <div className="mono" style={{ fontSize: 13, color: "#c3c1b8", width: 20 }}>{String(i + 1).padStart(2, "0")}</div>
                  <div style={{ flex: 1, fontSize: 16, fontWeight: 700 }}>{e[0]}</div>
                  <div className="mono" style={{ fontSize: 13, color: "#8a8a82" }}>{e[1]}</div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* ===================== TAB BAR ===================== */}
        <div className="tabbar">
          <button className={`tab ${state.tab === "today" ? "on" : ""}`} onClick={() => setState({ tab: "today" })}>
            <svg className="ic" viewBox="0 0 24 24"><path d="M3 11l9-8 9 8" /><path d="M5 10v9h14v-9" /></svg>Today
          </button>
          <button className={`tab ${state.tab === "progress" ? "on" : ""}`} onClick={() => setState({ tab: "progress" })}>
            <svg className="ic" viewBox="0 0 24 24"><path d="M4 19V5" /><path d="M4 19h16" /><path d="M8 15l3-4 3 2 4-6" /></svg>Progress
          </button>
          <button className={`tab ${state.tab === "calendar" ? "on" : ""}`} onClick={() => setState({ tab: "calendar" })}>
            <svg className="ic" viewBox="0 0 24 24"><rect x="3" y="5" width="18" height="16" rx="2" /><path d="M3 9h18M8 3v4M16 3v4" /></svg>Calendar
          </button>
          <button className={`tab ${state.tab === "coach" ? "on" : ""}`} onClick={() => setState({ tab: "coach" })}>
            <svg className="ic" viewBox="0 0 24 24"><path d="M4 5h16v11H8l-4 4z" /></svg>Coach
          </button>
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Cross-platform status-bar glyphs (the source used SF Symbols)
 * ------------------------------------------------------------------ */
function StatusIcons() {
  return (
    <span style={{ display: "flex", gap: 7, alignItems: "center" }}>
      <svg width="18" height="12" viewBox="0 0 18 12" fill="#12120f" aria-hidden>
        <rect x="0" y="8" width="3" height="4" rx="1" />
        <rect x="5" y="5" width="3" height="7" rx="1" />
        <rect x="10" y="2.5" width="3" height="9.5" rx="1" />
        <rect x="15" y="0" width="3" height="12" rx="1" />
      </svg>
      <svg width="16" height="12" viewBox="0 0 16 12" fill="none" stroke="#12120f" strokeWidth="1.6" strokeLinecap="round" aria-hidden>
        <path d="M1 4.4 A10 10 0 0 1 15 4.4" />
        <path d="M3.6 6.9 A6.2 6.2 0 0 1 12.4 6.9" />
        <circle cx="8" cy="9.8" r="1" fill="#12120f" stroke="none" />
      </svg>
      <svg width="25" height="12" viewBox="0 0 25 12" fill="none" aria-hidden>
        <rect x="0.5" y="1" width="20" height="10" rx="2.5" stroke="#12120f" strokeOpacity="0.4" />
        <rect x="2" y="2.5" width="15" height="7" rx="1.5" fill="#12120f" />
        <path d="M22.5 4 v4" stroke="#12120f" strokeOpacity="0.4" strokeWidth="1.8" strokeLinecap="round" />
      </svg>
    </span>
  );
}
