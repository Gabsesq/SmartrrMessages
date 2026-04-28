-- Run once in Supabase SQL Editor.
-- Dedupe lock ensures a phone number is called at most once per UTC month.

create table if not exists public.failed_payment_calls (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  called_at timestamptz,
  month_key text not null,
  phone_e164 text not null,
  event_type text,
  customer_email text,
  subscription_id text,
  status text not null default 'dedupe_locked',
  twilio_call_sid text,
  error_message text,
  payload jsonb not null default '{}'::jsonb
);

create unique index if not exists failed_payment_calls_phone_month_key_uniq
  on public.failed_payment_calls (phone_e164, month_key);

create index if not exists failed_payment_calls_created_at_idx
  on public.failed_payment_calls (created_at desc);

create index if not exists failed_payment_calls_status_idx
  on public.failed_payment_calls (status);
