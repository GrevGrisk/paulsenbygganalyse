-- Supabase/PostgreSQL schema for pre-flight records.
-- Apply only after Supabase Auth and organization membership have been configured.
create extension if not exists pgcrypto;

create table if not exists public.preflight_checks (
 id uuid primary key default gen_random_uuid(),
 organization_id uuid not null,
 created_by uuid not null references auth.users(id),
 flight_date date not null,
 flight_time time,
 flight_address text not null,
 pilot_name text not null,
 drone_serial text,
 purpose text not null,
 status text not null default 'draft' check (status in ('draft','finalized')),
 payload jsonb not null default '{}'::jsonb,
 finalized_at timestamptz,
 created_at timestamptz not null default now(),
 updated_at timestamptz not null default now(),
 constraint finalized_has_timestamp check (status <> 'finalized' or finalized_at is not null)
);
create index if not exists preflight_checks_org_date_idx on public.preflight_checks (organization_id,flight_date desc);
create index if not exists preflight_checks_address_idx on public.preflight_checks (organization_id,flight_address);
create table if not exists public.preflight_check_events (
 id bigint generated always as identity primary key,
 check_id uuid not null references public.preflight_checks(id),
 actor_id uuid not null references auth.users(id),
 event_type text not null,
 event_payload jsonb not null default '{}'::jsonb,
 recorded_at timestamptz not null default now()
);
create index if not exists preflight_events_check_idx on public.preflight_check_events(check_id,recorded_at);

-- Memberships must be provisioned by a trusted administrator, not by pilots.
create table if not exists public.preflight_org_members (
 organization_id uuid not null,
 user_id uuid not null references auth.users(id),
 primary key (organization_id,user_id)
);
alter table public.preflight_checks enable row level security;
alter table public.preflight_check_events enable row level security;
alter table public.preflight_org_members enable row level security;
create policy "Members see their memberships" on public.preflight_org_members for select to authenticated using (user_id=auth.uid());
create policy "Members read preflight checks" on public.preflight_checks for select to authenticated using (
 exists(select 1 from public.preflight_org_members m where m.organization_id=preflight_checks.organization_id and m.user_id=auth.uid())
);
create policy "Members create own preflight checks" on public.preflight_checks for insert to authenticated with check (
 created_by=auth.uid() and status='draft' and finalized_at is null and
 exists(select 1 from public.preflight_org_members m where m.organization_id=preflight_checks.organization_id and m.user_id=auth.uid())
);
create policy "Authors update draft preflight checks" on public.preflight_checks for update to authenticated using (
 created_by=auth.uid() and status='draft' and
 exists(select 1 from public.preflight_org_members m where m.organization_id=preflight_checks.organization_id and m.user_id=auth.uid())
) with check (
 created_by=auth.uid() and status in ('draft','finalized') and
 exists(select 1 from public.preflight_org_members m where m.organization_id=preflight_checks.organization_id and m.user_id=auth.uid())
);
create policy "Members read preflight history" on public.preflight_check_events for select to authenticated using (
 exists(select 1 from public.preflight_checks c join public.preflight_org_members m on m.organization_id=c.organization_id where c.id=preflight_check_events.check_id and m.user_id=auth.uid())
);
-- Event writes and finalization must be performed via a trusted backend transaction,
-- which validates data, writes an immutable snapshot and appends an event.
-- Do not grant direct event insert/update/delete to clients.
revoke insert,update,delete on public.preflight_check_events from anon,authenticated;
-- Production: add database triggers enforcing immutable finalized records and audit
-- on every draft update; configure backup/retention before handling real records.
