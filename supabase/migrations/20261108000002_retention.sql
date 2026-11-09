-- Apaga mensagens com mais de 90 dias e conversas que ficaram vazias, todo dia às 3h (UTC).
create extension if not exists pg_cron;

select cron.schedule(
  'apagar-conversas-90-dias',
  '0 3 * * *',
  $$
    delete from public.messages where created_at < now() - interval '90 days';
    delete from public.agent_events where created_at < now() - interval '90 days';
    delete from public.conversations c
    where c.created_at < now() - interval '90 days'
      and not exists (select 1 from public.messages m where m.conversation_id = c.id);
  $$
);
