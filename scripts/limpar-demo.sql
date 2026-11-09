-- Apaga conversas, telefones, fila, sugestões, cota e FAQs aprendidas na demonstração.
-- Os documentos fictícios permanecem. Execute no SQL Editor do Supabase.
truncate public.conversations, public.dismissed_phones, public.suggestions,
  public.quota_month, public.quota_day cascade;
delete from public.kb_chunks where source = 'faq';
