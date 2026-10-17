create table if not exists public.store_records (
  collection text not null,
  id text not null,
  payload jsonb not null,
  updated_at timestamptz not null default now(),
  primary key (collection, id)
);

alter table public.store_records enable row level security;
revoke all on table public.store_records from anon, authenticated;
grant all on table public.store_records to service_role;
