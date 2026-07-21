-- Gym Tracker — normalized schema, per-user rows, RLS for anonymous auth.
-- Run this in the Supabase SQL Editor (or via `supabase db push` once linked).
-- Anonymous sign-ins must also be enabled: Dashboard → Authentication → Sign In / Providers → Anonymous.

-- ============================================================ tables

-- Workout sessions: today's live session (kind='today') + upcoming planned days (kind='upcoming').
create table if not exists public.workouts (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users (id) on delete cascade,
  kind        text not null check (kind in ('today', 'upcoming')),
  title       text not null,
  subtitle    text not null default '',   -- muscle groups, e.g. "Chest · Shoulders · Triceps"
  color       text not null default '',   -- accent for upcoming cards
  date_label  text not null default '',   -- e.g. "TUE 22"
  position    int  not null default 0,
  created_at  timestamptz not null default now()
);

create table if not exists public.workout_exercises (
  id          uuid primary key default gen_random_uuid(),
  workout_id  uuid not null references public.workouts (id) on delete cascade,
  user_id     uuid not null references auth.users (id) on delete cascade,
  name        text not null,
  scheme      text not null default '',   -- for 'upcoming' plans, e.g. "4 × 5 · 100 kg"
  position    int  not null default 0
);

create table if not exists public.exercise_sets (
  id           uuid primary key default gen_random_uuid(),
  exercise_id  uuid not null references public.workout_exercises (id) on delete cascade,
  user_id      uuid not null references auth.users (id) on delete cascade,
  position     int     not null default 0,
  weight_kg    numeric not null default 0,
  reps         int     not null default 0,
  done         boolean not null default false
);

-- Lift records (PRs) grouped by split, with the last-N session history.
create table if not exists public.lift_records (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users (id) on delete cascade,
  name        text not null,
  plan        text not null check (plan in ('push', 'pull', 'legs')),
  current_kg  numeric not null default 0,
  note        text not null default '',
  position    int  not null default 0
);

create table if not exists public.lift_record_sessions (
  id          uuid primary key default gen_random_uuid(),
  record_id   uuid not null references public.lift_records (id) on delete cascade,
  user_id     uuid not null references auth.users (id) on delete cascade,
  position    int     not null default 0,   -- 0 = oldest … n = newest
  kg          numeric not null default 0
);

-- Body-weight log (append-only history).
create table if not exists public.body_weight_logs (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users (id) on delete cascade,
  weight_kg   numeric not null,
  logged_at   timestamptz not null default now()
);

-- Coach chat transcript.
create table if not exists public.coach_messages (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users (id) on delete cascade,
  sender      text not null check (sender in ('coach', 'user')),
  body        text not null,
  position    int  not null default 0,
  created_at  timestamptz not null default now()
);

-- ============================================================ indexes
create index if not exists workouts_user_idx            on public.workouts (user_id, kind, position);
create index if not exists workout_exercises_user_idx   on public.workout_exercises (user_id, workout_id, position);
create index if not exists exercise_sets_user_idx       on public.exercise_sets (user_id, exercise_id, position);
create index if not exists lift_records_user_idx        on public.lift_records (user_id, position);
create index if not exists lift_record_sessions_idx     on public.lift_record_sessions (user_id, record_id, position);
create index if not exists body_weight_logs_user_idx    on public.body_weight_logs (user_id, logged_at);
create index if not exists coach_messages_user_idx      on public.coach_messages (user_id, position);

-- ============================================================ RLS
-- Every table: a user (including anonymous users, who hold the `authenticated` role)
-- may only read/write rows whose user_id matches their auth.uid().
do $$
declare t text;
begin
  foreach t in array array[
    'workouts', 'workout_exercises', 'exercise_sets',
    'lift_records', 'lift_record_sessions', 'body_weight_logs', 'coach_messages'
  ]
  loop
    execute format('alter table public.%I enable row level security;', t);
    execute format('drop policy if exists own_select on public.%I;', t);
    execute format('drop policy if exists own_insert on public.%I;', t);
    execute format('drop policy if exists own_update on public.%I;', t);
    execute format('drop policy if exists own_delete on public.%I;', t);
    execute format('create policy own_select on public.%I for select to authenticated using (user_id = auth.uid());', t);
    execute format('create policy own_insert on public.%I for insert to authenticated with check (user_id = auth.uid());', t);
    execute format('create policy own_update on public.%I for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());', t);
    execute format('create policy own_delete on public.%I for delete to authenticated using (user_id = auth.uid());', t);
  end loop;
end $$;
