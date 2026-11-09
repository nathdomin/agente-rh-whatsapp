-- Esquema do agente de RH. Todo acesso passa pelas Edge Functions (service_role).

create schema if not exists extensions;
create extension if not exists unaccent with schema extensions;
create extension if not exists pg_trgm with schema extensions;

create function public.f_unaccent(text) returns text
language sql immutable parallel safe strict
set search_path = ''
as $$ select extensions.unaccent('extensions.unaccent'::regdictionary, $1) $$;

create table public.conversations (
  id uuid primary key default gen_random_uuid(),
  phone text not null unique,
  paused_until timestamptz,
  last_fixed_reply_at timestamptz,
  created_at timestamptz not null default now()
);

create table public.messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  wa_message_id text unique,
  direction text not null check (direction in ('in', 'out')),
  kind text not null,
  body text,
  media_id text,
  status text,
  processed_at timestamptz,
  retrieved jsonb,
  prompt_version text,
  reaction text,
  created_at timestamptz not null default now()
);
create index messages_conversation_created_idx on public.messages (conversation_id, created_at desc);
create index messages_unprocessed_idx on public.messages (conversation_id) where direction = 'in' and processed_at is null;

create table public.dismissed_phones (
  phone_key text primary key,
  created_at timestamptz not null default now()
);

create table public.kb_chunks (
  id bigint generated always as identity primary key,
  source text not null,
  title text not null,
  section text not null default '',
  content text not null,
  created_at timestamptz not null default now(),
  normalized text generated always as (lower(public.f_unaccent(title || ' ' || section || ' ' || content))) stored,
  search tsvector generated always as (
    setweight(to_tsvector('portuguese', public.f_unaccent(title || ' ' || section)), 'A') ||
    setweight(to_tsvector('portuguese', public.f_unaccent(content)), 'B')
  ) stored
);
create index kb_chunks_search_idx on public.kb_chunks using gin (search);

create table public.handoffs (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  reason text not null,
  question text not null,
  status text not null default 'aberto' check (status in ('aberto', 'resolvido')),
  human_answer text,
  created_at timestamptz not null default now(),
  resolved_at timestamptz
);
create unique index handoffs_one_open_idx on public.handoffs (conversation_id) where status = 'aberto';

create table public.suggestions (
  id uuid primary key default gen_random_uuid(),
  question text not null,
  answer text not null,
  status text not null default 'pendente' check (status in ('pendente', 'aprovado', 'rejeitado')),
  chunk_id bigint references public.kb_chunks(id) on delete set null,
  created_at timestamptz not null default now()
);

create table public.quota_month (
  month text primary key,
  used integer not null default 0,
  delivered integer not null default 0,
  simulated_exhausted boolean not null default false
);

create table public.quota_day (
  day text primary key,
  used integer not null default 0
);

create table public.agent_events (
  id bigint generated always as identity primary key,
  conversation_id uuid references public.conversations(id) on delete cascade,
  action text not null,
  detail jsonb,
  created_at timestamptz not null default now()
);

-- Reserva uma mensagem de forma atômica, respeitando os limites do mês e do dia.
create function public.reserve_quota(p_month text, p_day text, p_monthly_cap integer, p_daily_limit integer)
returns boolean
language plpgsql
set search_path = ''
as $$
declare
  v_month integer;
  v_day integer;
begin
  insert into public.quota_month (month) values (p_month) on conflict do nothing;
  insert into public.quota_day (day) values (p_day) on conflict do nothing;

  select used into v_month from public.quota_month where month = p_month for update;
  select used into v_day from public.quota_day where day = p_day for update;

  if v_month >= p_monthly_cap or v_day >= p_daily_limit then
    return false;
  end if;

  update public.quota_month set used = used + 1 where month = p_month;
  update public.quota_day set used = used + 1 where day = p_day;
  return true;
end;
$$;

create function public.release_quota(p_month text, p_day text)
returns void
language sql
set search_path = ''
as $$
  update public.quota_month set used = greatest(used - 1, 0) where month = p_month;
  update public.quota_day set used = greatest(used - 1, 0) where day = p_day;
$$;

create function public.count_delivered(p_month text)
returns void
language sql
set search_path = ''
as $$
  insert into public.quota_month (month, delivered) values (p_month, 1)
  on conflict (month) do update set delivered = public.quota_month.delivered + 1;
$$;

-- Busca híbrida: texto completo em português (radicais) + semelhança de palavras (erros de digitação).
create function public.search_kb(p_query text, p_keywords text[], p_limit integer default 4)
returns table (id bigint, title text, section text, content text)
language sql
stable
set search_path = ''
as $$
  with input as (
    select
      lower(public.f_unaccent(p_query)) as plain,
      replace(
        plainto_tsquery('portuguese', public.f_unaccent(p_query || ' ' || array_to_string(p_keywords, ' ')))::text,
        '&', '|'
      )::tsquery as query
  ),
  scored as (
    select
      c.id, c.title, c.section, c.content,
      ts_rank(c.search, input.query) as fts,
      extensions.word_similarity(input.plain, c.normalized) as trigram,
      c.search @@ input.query as fts_match
    from public.kb_chunks c, input
  ),
  ranked as (
    select *,
      row_number() over (order by fts desc) as fts_rank,
      row_number() over (order by trigram desc) as trigram_rank
    from scored
    where fts_match or trigram > 0.5
  )
  select ranked.id, ranked.title, ranked.section, ranked.content
  from ranked
  order by (1.0 / (60 + fts_rank)) + (1.0 / (60 + trigram_rank)) desc
  limit p_limit
$$;

-- Nada exposto a clientes públicos; apenas service_role.
alter table public.conversations enable row level security;
alter table public.messages enable row level security;
alter table public.dismissed_phones enable row level security;
alter table public.kb_chunks enable row level security;
alter table public.handoffs enable row level security;
alter table public.suggestions enable row level security;
alter table public.quota_month enable row level security;
alter table public.quota_day enable row level security;
alter table public.agent_events enable row level security;

revoke all on all tables in schema public from anon, authenticated;
revoke all on all functions in schema public from public, anon, authenticated;

grant usage on schema public to service_role;
grant select, insert, update, delete on all tables in schema public to service_role;
grant usage, select on all sequences in schema public to service_role;
grant execute on all functions in schema public to service_role;
