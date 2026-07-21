"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import type { Exercise, LiftPlan, PersistedState, Session, State } from "@/lib/types";
import {
  PLAN_COLOR,
  fromISO,
  longLabel,
  monthLabel,
  scheme,
  sessionVolume,
  shortLabel,
  todayISO,
  toISO,
} from "@/lib/types";
import { ensureUserId, getAccessToken, getSupabase, isSupabaseConfigured } from "@/lib/supabaseClient";
import { loadState, saveSession, seedRemote } from "@/lib/db";
import { buildSeed } from "@/lib/seed";

const STORAGE_KEY = "gymbro-state-v2";

const EMPTY: State = {
  sessions: [],
  records: [],
  messages: [],
  weighIns: [],
  memory: {},
  tab: "today",
  openEx: 0,
  openRecord: null,
  draft: "",
  modalPlan: null,
  dragY: 0,
  dragging: false,
  timerSec: 0,
  timerRunning: false,
  thinking: false,
};

const hairline: CSSProperties = { height: 1, background: "rgba(0,0,0,.09)" };

/* Set-row spinner: ▲/▼ stacked in one pill, so a row stays the same width
 * whatever the value is (60 vs 62.5 must not shift anything). */
const spinBox: CSSProperties = { display: "flex", flexDirection: "column", width: 22, height: 30, flex: "none", border: "1px solid #dcdad3", borderRadius: 7, background: "#fff", overflow: "hidden" };
const spinBtn: CSSProperties = { flex: 1, display: "flex", alignItems: "center", justifyContent: "center", border: "none", background: "none", padding: 0, fontSize: 7, lineHeight: 1, color: "#12120f", cursor: "pointer" };

function Spinner({ label, onUp, onDown }: { label: string; onUp: () => void; onDown: () => void }) {
  return (
    <div style={spinBox}>
      <button aria-label={`Increase ${label}`} onClick={onUp} style={{ ...spinBtn, borderBottom: "1px solid #e6e4de" }}>▲</button>
      <button aria-label={`Decrease ${label}`} onClick={onDown} style={spinBtn}>▼</button>
    </div>
  );
}

/* ------------------------------------------------------------------ *
 * Component
 * ------------------------------------------------------------------ */
export default function GymTracker() {
  const [today] = useState(todayISO);
  const [state, setS] = useState<State>(EMPTY);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [month, setMonth] = useState(() => `${todayISO().slice(0, 7)}-01`);

  const timerRef = useRef<number | null>(null);
  const dy0 = useRef(0);
  const chatRef = useRef<HTMLDivElement>(null);

  /* setState with merge semantics */
  const setState = useCallback(
    (u: Partial<State> | ((s: State) => Partial<State>)) =>
      setS((prev) => ({ ...prev, ...(typeof u === "function" ? u(prev) : u) })),
    [],
  );

  /* ---- persistence: Supabase (anonymous per-device) w/ localStorage fallback ---- */
  const userIdRef = useRef<string | null>(null);
  const hydratedRef = useRef(false);
  /* Serialized copy of what the database already holds for today, so a state
   * replacement coming *from* the server never bounces straight back to it. */
  const savedTodayRef = useRef<string>("");
  const saveTimer = useRef<number | undefined>(undefined);

  const adoptPersisted = useCallback(
    (data: PersistedState) => {
      /* Server state wins: drop any pending local write so a stale debounce
       * can't overwrite what the coach just saved. */
      window.clearTimeout(saveTimer.current);
      const t = data.sessions.find((s) => s.date === today);
      savedTodayRef.current = t ? JSON.stringify(t) : "";
      setState(data);
    },
    [setState, today],
  );

  // Hydrate once on mount: sign in anonymously, load rows (seeding a fresh user).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const seed = buildSeed(today);
      if (isSupabaseConfigured) {
        const uid = await ensureUserId();
        const supabase = getSupabase();
        if (uid && supabase && !cancelled) {
          userIdRef.current = uid;
          try {
            let data = await loadState(supabase, uid);
            if (!data) {
              await seedRemote(supabase, uid, seed);
              data = await loadState(supabase, uid);
            }
            if (data && !cancelled) adoptPersisted(data);
          } catch (e) {
            if (!cancelled) setError(e instanceof Error ? e.message : "Could not reach your training log.");
          }
        } else if (!cancelled) {
          loadLocal(seed);
        }
      } else if (!cancelled) {
        loadLocal(seed);
      }
      if (!cancelled) {
        hydratedRef.current = true;
        setReady(true);
      }
    })();

    function loadLocal(seed: PersistedState) {
      try {
        const raw = localStorage.getItem(STORAGE_KEY);
        adoptPersisted(raw ? (JSON.parse(raw) as PersistedState) : seed);
      } catch {
        adoptPersisted(seed);
      }
    }

    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /* ---- derived views over the one source of truth: `sessions` ---- */
  const todaySession = useMemo(() => state.sessions.find((s) => s.date === today) ?? null, [state.sessions, today]);
  const workout = todaySession?.exercises ?? [];
  const upcoming = useMemo(() => state.sessions.filter((s) => s.date > today).slice(0, 6), [state.sessions, today]);
  const byDate = useMemo(() => new Map(state.sessions.map((s) => [s.date, s])), [state.sessions]);

  // Persist the athlete's own edits to today's session. Coach edits already
  // went through the server, so those arrive pre-saved and are skipped here.
  const todayJson = todaySession ? JSON.stringify(todaySession) : "";
  useEffect(() => {
    if (!hydratedRef.current) return;
    if (todayJson === savedTodayRef.current) return;
    savedTodayRef.current = todayJson;

    const uid = userIdRef.current;
    const supabase = getSupabase();
    window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => {
      if (isSupabaseConfigured && uid && supabase && todayJson) {
        saveSession(supabase, uid, JSON.parse(todayJson) as Session).catch((e) =>
          setError(e instanceof Error ? e.message : "Could not save your session."),
        );
      }
    }, 700);
  }, [todayJson]);

  // localStorage mirror when Supabase isn't configured.
  useEffect(() => {
    if (!hydratedRef.current || isSupabaseConfigured) return;
    try {
      const { sessions, records, messages, weighIns, memory } = state;
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ sessions, records, messages, weighIns, memory }));
    } catch {
      /* storage full / unavailable */
    }
  }, [state]);

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
  }, [state.messages, state.thinking, state.tab]);

  /* ---- workout editing (writes into today's session) ---- */
  const patchToday = (fn: (ex: Exercise[]) => Exercise[]) =>
    setState((s) => ({
      sessions: s.sessions.map((sess) => (sess.date === today ? { ...sess, exercises: fn(sess.exercises) } : sess)),
    }));

  const toggleOpen = (i: number) => setState((s) => ({ openEx: s.openEx === i ? -1 : i }));
  const adjustWeight = (ei: number, si: number, delta: number) =>
    patchToday((w) => w.map((ex, i) => (i !== ei ? ex : { ...ex, sets: ex.sets.map((st, j) => (j !== si ? st : { ...st, w: Math.max(0, Math.round((st.w + delta) * 2) / 2) })) })));
  const adjustReps = (ei: number, si: number, delta: number) =>
    patchToday((w) => w.map((ex, i) => (i !== ei ? ex : { ...ex, sets: ex.sets.map((st, j) => (j !== si ? st : { ...st, r: Math.max(1, st.r + delta) })) })));
  const toggleSet = (ei: number, si: number) =>
    patchToday((w) => w.map((ex, i) => (i !== ei ? ex : { ...ex, sets: ex.sets.map((st, j) => (j !== si ? st : { ...st, d: !st.d })) })));

  /* ---- the coach: MiniMax, server-side, with write access to everything ---- */
  const askCoach = useCallback(
    async (text: string) => {
      const message = text.trim();
      if (!message) return;
      if (!isSupabaseConfigured) {
        setState({ tab: "coach" });
        setError("The coach needs Supabase configured — it reads and writes your training log there. Add your Supabase keys to .env.local.");
        return;
      }
      setError(null);
      setState((s) => ({
        tab: "coach",
        draft: "",
        thinking: true,
        messages: [...s.messages, { from: "user", text: message }],
      }));

      try {
        const token = isSupabaseConfigured ? await getAccessToken() : null;
        const res = await fetch("/api/coach", {
          method: "POST",
          headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
          body: JSON.stringify({ message, today }),
        });
        const data = (await res.json()) as { reply?: string; state?: PersistedState; error?: string };
        if (!res.ok || !data.state) throw new Error(data.error ?? "The coach didn't answer.");
        adoptPersisted(data.state);
      } catch (e) {
        setError(e instanceof Error ? e.message : "The coach is unreachable.");
      } finally {
        setState({ thinking: false });
      }
    },
    [adoptPersisted, setState, today],
  );

  const send = () => askCoach(state.draft);

  /* ---- finish workout → let the coach log it and write the summary ---- */
  const finish = () => {
    if (timerRef.current) clearInterval(timerRef.current);
    const mins = Math.round(state.timerSec / 60);
    setState({ timerRunning: false });
    askCoach(
      `I've finished today's session${mins ? ` — it took about ${mins} minutes` : ""}. Log it as complete, then give me the breakdown: volume, sets completed, and what to change next time.`,
    );
  };

  /* ---- modal (a scheduled session) ---- */
  const closeModal = () => setState({ modalPlan: null, dragY: 0, dragging: false });
  const dragStart = (e: React.PointerEvent<HTMLDivElement>) => { dy0.current = e.clientY; e.currentTarget.setPointerCapture?.(e.pointerId); setState({ dragging: true }); };
  const dragMove = (e: React.PointerEvent<HTMLDivElement>) => { if (!state.dragging) return; setState({ dragY: Math.max(0, e.clientY - dy0.current) }); };
  const dragEnd = () => { if (state.dragY > 90) closeModal(); else setState({ dragY: 0, dragging: false }); };
  const reviewSession = (s: Session) => {
    closeModal();
    askCoach(`Review my ${s.title} on ${s.date} (${s.groups}). Is it the right work for where I'm at, and would you change any of the loads?`);
  };

  /* ---- progress figures, all derived from stored sessions ---- */
  const monthStats = useMemo(() => {
    const prefix = month.slice(0, 7);
    const done = state.sessions.filter((s) => s.date.startsWith(prefix) && s.completed);
    return { count: done.length, volume: done.reduce((t, s) => t + sessionVolume(s), 0) };
  }, [state.sessions, month]);

  const bw = state.weighIns[state.weighIns.length - 1];
  const bwPrev = state.weighIns[state.weighIns.length - 2];
  const bwChange = bw && bwPrev ? +(bw.kg - bwPrev.kg).toFixed(1) : 0;

  /* ---- calendar grid for the displayed month ---- */
  const grid = useMemo(() => {
    const first = fromISO(month);
    const lead = (first.getDay() + 6) % 7; // Monday-first
    const days = new Date(first.getFullYear(), first.getMonth() + 1, 0).getDate();
    const cells: { key: string; iso: string | null }[] = [];
    for (let i = 0; i < lead; i++) cells.push({ key: `blank-${i}`, iso: null });
    for (let n = 1; n <= days; n++) {
      const iso = toISO(new Date(first.getFullYear(), first.getMonth(), n));
      cells.push({ key: iso, iso });
    }
    return cells;
  }, [month]);

  const shiftMonth = (delta: number) => {
    const d = fromISO(month);
    d.setMonth(d.getMonth() + delta);
    setMonth(toISO(new Date(d.getFullYear(), d.getMonth(), 1)));
  };

  /* ---- derived ---- */
  const doneCount = workout.filter((ex) => ex.sets.length > 0 && ex.sets.every((x) => x.d)).length;
  const timerLabel = Math.floor(state.timerSec / 60).toString().padStart(2, "0") + ":" + (state.timerSec % 60).toString().padStart(2, "0");
  const sign = (v: number) => (v >= 0 ? "+" : "−") + Math.abs(v);
  const modal = state.modalPlan ? byDate.get(state.modalPlan) ?? null : null;

  if (!ready) {
    return (
      <div className="app">
        <div className="body" style={{ display: "flex", alignItems: "center", justifyContent: "center" }}>
          <div className="klabel">Loading your log…</div>
        </div>
      </div>
    );
  }

  /* ================================================================ *
   * Render
   * ================================================================ */
  return (
    <div className="app">
        <div className="body">
          {/* ===================== TODAY ===================== */}
          {state.tab === "today" && (
            <div style={{ padding: "14px 26px 30px" }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <div className="klabel">{longLabel(today)}</div>
                <div style={{ width: 34, height: 34, borderRadius: "50%", background: "#e2e0da" }} />
              </div>
              <div style={{ display: "flex", alignItems: "flex-end", justifyContent: "space-between", gap: 12, margin: "20px 0 4px" }}>
                <h1 style={{ margin: 0, fontSize: 38, fontWeight: 800, lineHeight: 0.98, letterSpacing: "-.02em" }}>{todaySession?.title ?? "Nothing planned"}</h1>
                <button
                  onClick={toggleTimer}
                  style={{ display: "flex", alignItems: "center", gap: 7, border: `1px solid ${state.timerRunning ? "#3c8cff" : "#dcdad3"}`, background: state.timerRunning ? "#eaf2ff" : "#fff", color: state.timerRunning ? "#2d6fd0" : "#12120f", borderRadius: 12, padding: "7px 12px", cursor: "pointer", flex: "none", transform: "translateY(-3px)" }}
                >
                  <span style={{ width: 8, height: 8, borderRadius: "50%", background: state.timerRunning ? "#3c8cff" : "#c3c1b8" }} />
                  <span className="mono" style={{ fontSize: 16, fontWeight: 700, letterSpacing: ".02em" }}>{timerLabel}</span>
                </button>
              </div>
              <div style={{ fontSize: 15, color: "#6b6b64" }}>{todaySession?.groups ?? "Ask your coach to plan something"}</div>
              {workout.length > 0 && (
                <div className="mono" style={{ fontSize: 13, color: "#3c8cff", fontWeight: 600, marginTop: 4 }}>
                  {doneCount} of {workout.length} done{todaySession?.completed ? " · logged" : ""}
                </div>
              )}
              {todaySession?.notes && (
                <div style={{ marginTop: 12, padding: "11px 13px", borderRadius: 12, background: "#efedE7", fontSize: 13, lineHeight: 1.45, color: "#4a4a44" }}>{todaySession.notes}</div>
              )}
              <div style={{ ...hairline, margin: "22px -26px 0" }} />

              {workout.length === 0 && (
                <div style={{ padding: "40px 0 8px", textAlign: "center" }}>
                  <div style={{ fontSize: 15, color: "#8a8a82", lineHeight: 1.5 }}>
                    {todaySession ? "Rest day — nothing on the bar." : "No session on the calendar for today."}
                  </div>
                  <button className="btnp" style={{ marginTop: 20 }} onClick={() => askCoach("Plan me a session for today based on where I am in my split, and put it on the calendar.")}>
                    Ask coach to plan today
                  </button>
                </div>
              )}

              {workout.map((ex, i) => {
                const nsets = ex.sets.length;
                const ndone = ex.sets.filter((x) => x.d).length;
                const allDone = nsets > 0 && ndone === nsets;
                const open = state.openEx === i;
                return (
                  <div key={`${ex.name}-${i}`} style={{ borderBottom: "1px solid rgba(0,0,0,.07)" }}>
                    <button onClick={() => toggleOpen(i)} style={{ display: "flex", alignItems: "center", gap: 14, padding: "18px 0", border: "none", background: "none", width: "100%", textAlign: "left", cursor: "pointer" }}>
                      <div className="mono" style={{ fontSize: 13, color: "#c3c1b8", width: 20 }}>{String(i + 1).padStart(2, "0")}</div>
                      <div style={{ flex: 1 }}>
                        <div style={{ fontSize: 17, fontWeight: 700, color: allDone ? "#9a9a92" : "#12120f" }}>{ex.name}</div>
                        <div className="mono" style={{ fontSize: 13, color: "#8a8a82", marginTop: 3 }}>{scheme(ex)}</div>
                      </div>
                      <div className="mono" style={{ fontSize: 12, color: "#3c8cff", fontWeight: 600 }}>{ndone}/{nsets}</div>
                      <div style={{ color: "#c3c1b8", fontSize: 14, transform: `rotate(${open ? 180 : 0}deg)`, transition: "transform .2s" }}>▾</div>
                    </button>
                    {open && (
                      <div style={{ padding: "2px 0 16px 30px", display: "flex", flexDirection: "column", gap: 6 }}>
                        {ex.sets.map((st, j) => (
                          <div key={j} style={{ display: "flex", alignItems: "center", gap: 10, width: "100%", maxWidth: 296, padding: "7px 12px", borderRadius: 13, background: j % 2 === 0 ? "#eef2fa" : "#f5f4f1" }}>
                            <button
                              onClick={() => toggleSet(i, j)}
                              aria-label={`Mark set ${j + 1} ${st.d ? "not done" : "done"}`}
                              style={{ width: 22, height: 22, flex: "none", border: `2px solid ${st.d ? "#3c8cff" : "#d0cec7"}`, background: st.d ? "#3c8cff" : "transparent", borderRadius: "50%", display: "flex", alignItems: "center", justifyContent: "center", color: "#fff", fontSize: 11, cursor: "pointer" }}
                            >
                              {st.d ? "✓" : ""}
                            </button>
                            <div className="mono" style={{ fontSize: 11, color: "#8a8a82", width: 32, flex: "none" }}>Set {j + 1}</div>
                            <div className="mono" style={{ width: 52, flex: "none", textAlign: "right", fontSize: 19, fontWeight: 700, letterSpacing: "-.01em" }}>{st.w}</div>
                            <div style={{ fontSize: 11, color: "#8a8a82", width: 14, flex: "none", marginLeft: -4 }}>kg</div>
                            <Spinner label={`weight of set ${j + 1}`} onUp={() => adjustWeight(i, j, 2.5)} onDown={() => adjustWeight(i, j, -2.5)} />
                            <div className="mono" style={{ width: 26, flex: "none", textAlign: "right", fontSize: 19, fontWeight: 700, letterSpacing: "-.01em" }}>{st.r}</div>
                            <div style={{ fontSize: 11, color: "#8a8a82", width: 24, flex: "none", marginLeft: -4 }}>reps</div>
                            <Spinner label={`reps of set ${j + 1}`} onUp={() => adjustReps(i, j, 1)} onDown={() => adjustReps(i, j, -1)} />
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
              {workout.length > 0 && (
                <button className="btnp" style={{ marginTop: 24 }} onClick={finish} disabled={state.thinking}>
                  {state.thinking ? "Coach is logging it…" : "Finish Workout"}
                </button>
              )}
            </div>
          )}

          {/* ===================== PROGRESS ===================== */}
          {state.tab === "progress" && (
            <div style={{ padding: "14px 26px 30px" }}>
              <div className="klabel">Progress</div>
              <h1 style={{ margin: "12px 0 20px", fontSize: 34, fontWeight: 800, letterSpacing: "-.02em" }}>This month</h1>
              <div style={{ display: "flex", borderTop: "1px solid rgba(0,0,0,.09)" }}>
                <div style={{ flex: 1, padding: "16px 0", borderRight: "1px solid rgba(0,0,0,.09)" }}>
                  <div className="mono" style={{ fontSize: 30, fontWeight: 700, letterSpacing: "-.02em" }}>{monthStats.count}</div>
                  <div style={{ fontSize: 12, color: "#8a8a82" }}>workouts</div>
                </div>
                <div style={{ flex: 1, padding: "16px 0 16px 18px" }}>
                  <div className="mono" style={{ fontSize: 30, fontWeight: 700, letterSpacing: "-.02em" }}>{(monthStats.volume / 1000).toFixed(1)}<span style={{ fontSize: 14 }}>t</span></div>
                  <div style={{ fontSize: 12, color: "#8a8a82" }}>total volume</div>
                </div>
              </div>
              <div style={hairline} />

              <div style={{ marginTop: 26 }} className="klabel">Body weight</div>
              {bw ? (
                <>
                  <div style={{ display: "flex", alignItems: "baseline", gap: 8, margin: "8px 0 12px" }}>
                    <div className="mono" style={{ fontSize: 26, fontWeight: 700 }}>{bw.kg} kg</div>
                    <div className="mono" style={{ fontSize: 13, color: "#3c8cff", fontWeight: 600 }}>{sign(bwChange)} kg</div>
                  </div>
                  <WeightChart points={state.weighIns.slice(-12).map((w) => w.kg)} />
                </>
              ) : (
                <div style={{ fontSize: 14, color: "#8a8a82", margin: "8px 0" }}>No weigh-ins yet — tell the coach “log body weight 78”.</div>
              )}

              <div style={{ marginTop: 26, display: "flex", alignItems: "baseline", justifyContent: "space-between" }}>
                <span className="klabel">Lift records</span>
                <span className="mono" style={{ fontSize: 11, color: "#c3c1b8" }}>PPL split · tap to expand</span>
              </div>
              {([{ key: "push", label: "Push" }, { key: "pull", label: "Pull" }, { key: "legs", label: "Legs" }] as { key: LiftPlan; label: string }[]).map((g) => {
                const color = PLAN_COLOR[g.key];
                const group = state.records.filter((r) => r.plan === g.key);
                if (!group.length) return null;
                return (
                  <div key={g.key}>
                    <div style={{ marginTop: 16, display: "flex", alignItems: "center", gap: 8 }}>
                      <span style={{ width: 9, height: 9, borderRadius: "50%", background: color }} />
                      <span className="klabel" style={{ color }}>{g.label}</span>
                    </div>
                    <div style={{ display: "flex", flexDirection: "column", marginTop: 2 }}>
                      {group.map((r) => {
                        const open = state.openRecord === r.name;
                        const hist = r.hist.length ? r.hist : [r.kg];
                        const mx = Math.max(...hist), mn = Math.min(...hist), rng = mx - mn || 1;
                        const d = +(hist[hist.length - 1] - hist[0]).toFixed(1);
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
                                  {hist.map((v, idx) => {
                                    const isLast = idx === hist.length - 1;
                                    return (
                                      <div key={idx} style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "flex-end", gap: 5, height: "100%" }}>
                                        <span className="mono" style={{ fontSize: 10, color: isLast ? "#12120f" : "#a7a79f", fontWeight: 600 }}>{v}</span>
                                        <div style={{ width: "100%", background: isLast ? color : "#d8d6cf", borderRadius: 4, height: 12 + Math.round(((v - mn) / rng) * 30) }} />
                                      </div>
                                    );
                                  })}
                                </div>
                                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline" }}>
                                  <span className="mono" style={{ fontSize: 11, color: "#9a9a92" }}>last {hist.length} sessions (kg)</span>
                                  <span className="mono" style={{ fontSize: 11, color: "#3c8cff", fontWeight: 600 }}>{sign(d)} kg over {hist.length}</span>
                                </div>
                                {r.note && <div style={{ fontSize: 13, color: "#6b6b64", marginTop: 6, lineHeight: 1.4 }}>{r.note}</div>}
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  </div>
                );
              })}

              {Object.keys(state.memory).length > 0 && (
                <>
                  <div style={{ marginTop: 26 }} className="klabel">What your coach knows</div>
                  <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 10 }}>
                    {Object.entries(state.memory).map(([k, v]) => (
                      <div key={k} style={{ display: "flex", gap: 10, alignItems: "baseline", padding: "10px 13px", borderRadius: 12, background: "#efedE7" }}>
                        <span className="mono" style={{ fontSize: 11, color: "#8a8a82", flex: "none" }}>{k.replace(/_/g, " ")}</span>
                        <span style={{ fontSize: 13, lineHeight: 1.4 }}>{v}</span>
                      </div>
                    ))}
                  </div>
                </>
              )}

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
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", margin: "12px 0 20px" }}>
                <h1 style={{ margin: 0, fontSize: 34, fontWeight: 800, letterSpacing: "-.02em" }}>{monthLabel(month)}</h1>
                <div style={{ display: "flex", gap: 6 }}>
                  {([["‹", -1], ["›", 1]] as [string, number][]).map(([glyph, delta]) => (
                    <button key={glyph} onClick={() => shiftMonth(delta)} aria-label={delta < 0 ? "Previous month" : "Next month"} style={{ width: 32, height: 32, borderRadius: 10, border: "1px solid #dcdad3", background: "#fff", cursor: "pointer", fontSize: 16, color: "#12120f" }}>{glyph}</button>
                  ))}
                </div>
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "repeat(7,1fr)", textAlign: "center" }}>
                {["M", "T", "W", "T", "F", "S", "S"].map((d, i) => (
                  <div key={i} className="mono" style={{ fontSize: 11, color: "#9a9a92", paddingBottom: 10 }}>{d}</div>
                ))}
                {grid.map((cell) => {
                  const session = cell.iso ? byDate.get(cell.iso) : undefined;
                  const isToday = cell.iso === today;
                  const planColor = session && session.plan !== "rest" ? PLAN_COLOR[session.plan] : null;
                  const filled = Boolean(session?.completed) && Boolean(planColor);
                  return (
                    <button
                      key={cell.key}
                      onClick={() => cell.iso && session && session.exercises.length > 0 && setState({ modalPlan: cell.iso })}
                      disabled={!session || session.exercises.length === 0}
                      style={{ aspectRatio: "1", display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", border: "none", background: "none", padding: 0, cursor: session?.exercises.length ? "pointer" : "default" }}
                    >
                      <span className="mono" style={{ fontSize: 14, color: isToday ? "#fff" : "#12120f", fontWeight: isToday ? 700 : 400, width: 26, height: 26, display: "flex", alignItems: "center", justifyContent: "center", borderRadius: "50%", background: isToday ? "#12120f" : "transparent" }}>
                        {cell.iso ? String(fromISO(cell.iso).getDate()) : ""}
                      </span>
                      <span
                        style={{
                          width: 5,
                          height: 5,
                          borderRadius: "50%",
                          marginTop: 3,
                          background: filled ? planColor! : "transparent",
                          border: !filled && planColor ? `1px solid ${planColor}` : "1px solid transparent",
                        }}
                      />
                    </button>
                  );
                })}
              </div>
              <div style={{ ...hairline, margin: "20px -26px" }} />
              <div style={{ display: "flex", flexWrap: "wrap", gap: 14, fontSize: 12, color: "#8a8a82" }}>
                {([["Push", PLAN_COLOR.push], ["Pull", PLAN_COLOR.pull], ["Legs", PLAN_COLOR.legs], ["Today", "#12120f"]] as [string, string][]).map(([label, c]) => (
                  <span key={label} style={{ display: "flex", alignItems: "center", gap: 6 }}><span style={{ width: 8, height: 8, borderRadius: "50%", background: c }} />{label}</span>
                ))}
                <span style={{ display: "flex", alignItems: "center", gap: 6 }}><span style={{ width: 8, height: 8, borderRadius: "50%", border: "1px solid #9a9a92" }} />Planned</span>
              </div>
              <div className="klabel" style={{ marginTop: 24 }}>Upcoming</div>
              <div style={{ display: "flex", flexDirection: "column", marginTop: 6 }}>
                {upcoming.length === 0 && <div style={{ fontSize: 14, color: "#8a8a82", padding: "14px 0" }}>Nothing scheduled. Ask your coach to build the week.</div>}
                {upcoming.map((p) => {
                  const rest = p.exercises.length === 0;
                  return (
                    <button key={p.date} onClick={() => !rest && setState({ modalPlan: p.date })} style={{ display: "flex", gap: 14, alignItems: "center", padding: "15px 0", border: "none", borderBottom: "1px solid rgba(0,0,0,.07)", background: "none", width: "100%", textAlign: "left", cursor: rest ? "default" : "pointer" }}>
                      <div className="mono" style={{ fontSize: 13, color: "#c3c1b8", width: 44, flex: "none" }}>{shortLabel(p.date)}</div>
                      <div style={{ width: 6, height: 30, borderRadius: 4, background: PLAN_COLOR[p.plan], flex: "none" }} />
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
                    <div style={{ fontSize: 11, color: "#8a8a82" }}>MiniMax · reads and writes your whole log</div>
                  </div>
                </div>
              </div>
              <div ref={chatRef} style={{ flex: 1, overflowY: "auto", padding: "20px 22px", display: "flex", flexDirection: "column", gap: 14 }}>
                {state.messages.map((mmsg, i) => {
                  const coach = mmsg.from === "coach";
                  return (
                    <div key={i} style={{ alignSelf: coach ? "flex-start" : "flex-end", maxWidth: "84%", display: "flex", flexDirection: "column", gap: 6 }}>
                      <div style={{ background: coach ? "#efedE7" : "#12120f", color: coach ? "#12120f" : "#fff", padding: "12px 15px", borderRadius: coach ? "4px 16px 16px 16px" : "16px 16px 4px 16px", fontSize: 14, lineHeight: 1.45, whiteSpace: "pre-line" }}>{mmsg.text}</div>
                      {mmsg.actions?.length ? (
                        <div style={{ display: "flex", flexDirection: "column", gap: 3, paddingLeft: 2 }}>
                          {mmsg.actions.map((a, k) => (
                            <div key={k} className="mono" style={{ fontSize: 10.5, color: "#3c8cff", display: "flex", gap: 5 }}>
                              <span style={{ flex: "none" }}>✓</span>
                              <span>{a}</span>
                            </div>
                          ))}
                        </div>
                      ) : null}
                    </div>
                  );
                })}
                {state.thinking && (
                  <div style={{ alignSelf: "flex-start", background: "#efedE7", padding: "12px 15px", borderRadius: "4px 16px 16px 16px" }}>
                    <span className="mono" style={{ fontSize: 12, color: "#8a8a82" }}>Coach is working…</span>
                  </div>
                )}
                {error && (
                  <div style={{ alignSelf: "center", maxWidth: "90%", background: "#fdecec", color: "#8f2d2d", padding: "10px 14px", borderRadius: 12, fontSize: 12.5, lineHeight: 1.45 }}>{error}</div>
                )}
              </div>
              <div style={{ flex: "none", padding: "12px 18px 16px", borderTop: "1px solid rgba(0,0,0,.08)", display: "flex", gap: 10, alignItems: "center" }}>
                <input
                  value={state.draft}
                  onInput={(e) => setState({ draft: (e.target as HTMLInputElement).value })}
                  onKeyDown={(e) => { if (e.key === "Enter" && !state.thinking) send(); }}
                  placeholder="Ask for anything — “make today easier”, “plan my week”…"
                  /* 16px, not 14 — iOS Safari auto-zooms the page on focus for anything
                     smaller, and we can't lock that out with maximumScale (see layout.tsx). */
                  style={{ flex: 1, minWidth: 0, border: "1px solid #dcdad3", borderRadius: 22, padding: "11px 16px", font: "400 16px var(--font-hanken)", background: "#fff", outline: "none" }}
                />
                <button onClick={send} disabled={state.thinking || !state.draft.trim()} style={{ width: 44, height: 44, borderRadius: "50%", background: state.thinking || !state.draft.trim() ? "#c3c1b8" : "#12120f", color: "#fff", border: "none", fontSize: 18, cursor: state.thinking ? "default" : "pointer", flex: "none" }}>↑</button>
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
                  <div className="klabel">{shortLabel(modal.date)}</div>
                  <h2 style={{ margin: "6px 0 3px", fontSize: 30, fontWeight: 800, letterSpacing: "-.02em" }}>{modal.title}</h2>
                  <div style={{ fontSize: 14, color: "#6b6b64" }}>{modal.groups}</div>
                </div>
                <button onClick={() => reviewSession(modal)} style={{ display: "flex", alignItems: "center", gap: 6, height: 34, padding: "0 13px", borderRadius: 17, border: "none", background: "#12120f", color: "#fff", font: "600 13px var(--font-hanken)", cursor: "pointer", flex: "none" }}><span style={{ color: "#3c8cff" }}>✦</span>Ask Coach</button>
              </div>
              <div className="mono" style={{ fontSize: 13, color: "#3c8cff", fontWeight: 600, marginTop: 6 }}>{modal.exercises.length} exercises{modal.completed ? " · completed" : ""}</div>
              {modal.notes && <div style={{ marginTop: 12, padding: "11px 13px", borderRadius: 12, background: "#efedE7", fontSize: 13, lineHeight: 1.45, color: "#4a4a44" }}>{modal.notes}</div>}
              <div style={{ ...hairline, margin: "16px -26px 0" }} />
              {modal.exercises.map((e, i) => (
                <div key={i} style={{ display: "flex", alignItems: "baseline", gap: 14, padding: "16px 0", borderBottom: "1px solid rgba(0,0,0,.07)" }}>
                  <div className="mono" style={{ fontSize: 13, color: "#c3c1b8", width: 20 }}>{String(i + 1).padStart(2, "0")}</div>
                  <div style={{ flex: 1, fontSize: 16, fontWeight: 700 }}>{e.name}</div>
                  <div className="mono" style={{ fontSize: 13, color: "#8a8a82" }}>{scheme(e)}</div>
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
            <svg className="ic" viewBox="0 0 24 24"><path d="M4 5h16v11H8l-4 4z" /></svg>
            {state.thinking ? <span style={{ color: "#3c8cff" }}>Working…</span> : "Coach"}
          </button>
        </div>
    </div>
  );
}

/** Body-weight trend, scaled to whatever range the athlete's log actually has. */
function WeightChart({ points }: { points: number[] }) {
  if (points.length < 2) return <div style={{ height: 90 }} />;
  const mx = Math.max(...points), mn = Math.min(...points), rng = mx - mn || 1;
  const coords = points.map((v, i) => {
    const x = (i / (points.length - 1)) * 300;
    const y = 78 - ((v - mn) / rng) * 62;
    return [x, y] as const;
  });
  const last = coords[coords.length - 1];
  return (
    <svg viewBox="0 0 300 90" style={{ width: "100%", height: 90, display: "block" }}>
      <polyline points={coords.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(" ")} fill="none" stroke="#3c8cff" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx={last[0].toFixed(1)} cy={last[1].toFixed(1)} r="4" fill="#3c8cff" />
    </svg>
  );
}
