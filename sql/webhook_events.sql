-- Run once in Supabase → SQL Editor (project linked to Vercel).

create table if not exists public.webhook_events (
  id uuid primary key default gen_random_uuid(),
  received_at timestamptz not null default now(),
  event_type text,
  subscription_id text,
  customer_email text,
  payload jsonb not null default '{}'::jsonb,
  request_headers jsonb
);

create index if not exists webhook_events_received_at_idx
  on public.webhook_events (received_at desc);

create index if not exists webhook_events_event_type_idx
  on public.webhook_events (event_type);

comment on table public.webhook_events is 'Inbound Smartrr (and other) webhook payloads stored by Vercel api/webhook.js';
