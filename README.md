# Gym Tracker

A mobile-first gym tracker whose coach is a real AI engine. **MiniMax** reads the
athlete's entire training log out of Supabase and writes back to it — today's
session, the calendar, records and body weight are all things the coach can change
by calling tools, not by pretending.

Next.js (App Router) + React + Supabase. No runtime UI dependencies.

## How it works

```
browser  ──POST /api/coach (Supabase JWT)──▶  route handler
                                              │
                                              ├─ loadState()      ← the whole log
                                              ├─ MiniMax chat + tools ⇄ EXECUTORS
                                              │                        └─ writes to Supabase (RLS)
                                              └─ returns reply + actions + fresh state
browser  ◀── re-renders every tab from the returned state
```

- **Supabase is the brain.** Every session is a row keyed by `scheduled_date`, so
  "today's plan", the "upcoming" list and the month grid are three views of one
  table — which is why the coach can edit any of them through one code path.
  `coach_memory` holds durable facts (goals, injuries, schedule) that outlive the chat.
- **The coach acts, then reports.** Each turn runs a tool-calling loop (max 6
  rounds). Whatever it actually changed is stored on the message and shown as a
  `✓` line under the reply, so a claimed edit and a real edit can't diverge.
- **RLS all the way down.** The API route builds a Supabase client from the
  athlete's own JWT, so the model's writes are constrained by the same row-level
  policies as the browser's. No service-role key exists in this app.

### What the coach can change

| Tool | Effect |
| --- | --- |
| `update_session` | Create/rewrite any calendar day: title, split, exercises, notes, completed |
| `delete_session` | Clear a day |
| `add_exercise` / `remove_exercise` / `update_exercise` | Edit one lift (absolute or `+2.5 kg`-style deltas) |
| `mark_sets` | Tick sets or a whole session off as trained |
| `log_body_weight` | Add a weigh-in to the Progress chart |
| `upsert_record` | Set a PR and push it onto that lift's history |
| `remember` / `forget` | Durable facts about the athlete |

Try: *"make today easier, my shoulder is sore"*, *"plan my week around 4 sessions"*,
*"move leg day to Friday"*, *"I hit 125 on deadlift"*, *"I weigh 77.5 today"*.

## Tabs

- **Today** — the session scheduled for the current date, with an inline stopwatch.
  Expand an exercise to step weight (±2.5 kg) and reps, and tick sets off.
  **Finish Workout** hands the session to the coach, which logs it and writes the breakdown.
- **Progress** — month totals computed from logged sets, a body-weight trend from
  real weigh-ins, per-lift records by Push / Pull / Legs, and what the coach remembers about you.
- **Calendar** — a month grid built from your sessions (filled dot = trained,
  outline = planned), month navigation, and an **Upcoming** list. Tapping a day
  opens a drag-to-dismiss sheet with **Ask Coach**.
- **Coach** — MiniMax, with write access to everything above.

## Setup

```bash
npm install
cp .env.example .env.local     # fill in Supabase + MINIMAX_API_KEY
npm run dev                    # http://localhost:3000
```

Supabase needs:

1. The migrations in `supabase/migrations/` applied (SQL editor or `supabase db push`).
2. Anonymous sign-in enabled — Dashboard → Authentication → Sign In / Providers → Anonymous.

`MINIMAX_API_KEY` is server-side only; it is read by `/api/coach` and never reaches
the browser. `MINIMAX_MODEL` (default `MiniMax-M2.1`) and `MINIMAX_BASE_URL` are optional.

A brand-new device signs in anonymously and gets seeded with a month of plausible
PPL history built around the day it first opens the app, so every chart and dot is live
from the first render.

## Tests

```bash
npm test          # every coach tool against an in-memory fake Supabase client
npm run smoke     # end-to-end: real anonymous athlete → MiniMax → rows in Postgres
                  # (needs `npm run dev` in another terminal)
```

`npm test` needs no network or keys — it proves the tool executors, the date and
fuzzy-matching helpers, and the context builder. `npm run smoke` proves the whole
loop by asking the coach to make changes and then reading the rows back.

## Build & deploy

```bash
npm run build
npm start
```

Zero-config on Vercel — set the three env vars in the project settings, then `vercel`.

## Layout

`app/GymTracker.tsx` holds the UI; `lib/` holds the data layer (`db.ts`), types and
date helpers (`types.ts`), seed data (`seed.ts`), the MiniMax client (`minimax.ts`)
and the coach's prompt + tools (`coach/`).
