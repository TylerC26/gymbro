-- Make Supabase the brain the AI coach reads from and writes to.
--
-- 1. Every training session becomes a real calendar event: `scheduled_date` is
--    its identity, so "today's plan", "the upcoming list" and "the month grid"
--    are all the same table filtered by date. The coach can therefore edit any
--    day with one code path.
-- 2. `coach_memory` gives the coach durable facts about the athlete (goals,
--    injuries, preferences) that outlive the chat transcript.
-- 3. `coach_messages.actions` records what each reply actually changed, so the
--    UI can show the write-back instead of just claiming it happened.

-- ======================================================== workouts → sessions

alter table public.workouts drop constraint if exists workouts_kind_check;
alter table public.workouts alter column kind set default 'session';
alter table public.workouts alter column title set default '';

alter table public.workouts
  add column if not exists scheduled_date date,
  add column if not exists plan      text,
  add column if not exists completed boolean not null default false,
  add column if not exists notes     text not null default '';

do $$ begin
  alter table public.workouts
    add constraint workouts_plan_check
    check (plan is null or plan in ('push', 'pull', 'legs', 'rest'));
exception when duplicate_object then null;
end $$;

-- One session per day per athlete: lets the coach upsert a date idempotently.
create unique index if not exists workouts_user_date_uniq
  on public.workouts (user_id, scheduled_date)
  where scheduled_date is not null;

create index if not exists workouts_user_sched_idx
  on public.workouts (user_id, scheduled_date);

-- ======================================================== coach write-back log

alter table public.coach_messages
  add column if not exists actions jsonb not null default '[]'::jsonb;

-- ======================================================== coach memory

create table if not exists public.coach_memory (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references auth.users (id) on delete cascade,
  key        text not null,           -- e.g. "goal", "injuries", "training_days"
  value      text not null,
  updated_at timestamptz not null default now(),
  unique (user_id, key)
);

create index if not exists coach_memory_user_idx on public.coach_memory (user_id, key);

alter table public.coach_memory enable row level security;

drop policy if exists own_select on public.coach_memory;
drop policy if exists own_insert on public.coach_memory;
drop policy if exists own_update on public.coach_memory;
drop policy if exists own_delete on public.coach_memory;

create policy own_select on public.coach_memory for select to authenticated using (user_id = auth.uid());
create policy own_insert on public.coach_memory for insert to authenticated with check (user_id = auth.uid());
create policy own_update on public.coach_memory for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy own_delete on public.coach_memory for delete to authenticated using (user_id = auth.uid());
