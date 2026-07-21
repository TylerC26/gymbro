# Gym Tracker

A minimal, mobile-first gym tracker built from the Claude Design **Gym Tracker** prototype. Next.js (App Router) + React, no runtime UI dependencies.

## Features

- **Today** — your session plan with an inline stopwatch. Expand any exercise to step weight (±2.5 kg) and reps per set, and tick sets off. **Finish Workout** rolls the logged sets into a coach summary (volume, sets, heaviest working set).
- **Progress** — month totals, a body-weight trend line, per-lift records grouped by Push / Pull / Legs (tap to expand a 4-session bar chart + note), and progress-photo slots.
- **Calendar** — July 2026 training calendar colour-coded by split, a legend, and an **Upcoming** list. Tapping a session opens a drag-to-dismiss detail sheet with an **Ask Coach** shortcut.
- **Coach** — a natural-language assistant that actually edits your plan. Try:
  - `set bench to 65 kg`
  - `add 2.5 kg to squat`
  - `make cable fly 4×15`
  - `overhead press 10 reps`
  - `mark triceps pushdown done`
  - `add lateral raise to today`
  - `log body weight 77.5`
  - `new deadlift PR 125`
  - `help`

State persists to `localStorage`, so your edits survive a refresh.

## Develop

```bash
npm install
npm run dev      # http://localhost:3000
```

## Build

```bash
npm run build
npm start
```

## Deploy

Zero-config on Vercel — push the repo and import it, or run `vercel`.

## Notes

The layout renders inside a phone frame on desktop and goes full-screen on
viewports ≤ 460px. All logic (the workout editor, the stopwatch, the record
charts, and the coach command parser) is ported from the original
`Gym Tracker.dc.html` design and lives in `app/GymTracker.tsx`.
