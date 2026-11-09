import { loadAgentConfig, requireEnv } from "../_shared/config.ts";
import { draftFaq } from "../_shared/faq.ts";
import { createGroqClient } from "../_shared/llm.ts";
import { maskPhone, phoneKey } from "../_shared/phone.ts";
import { maskPersonalData } from "../_shared/privacy.ts";
import { localDate } from "../_shared/quota.ts";
import { createDb } from "../_shared/supabase-store.ts";

const env = (name: string) => Deno.env.get(name);

const secret = requireEnv(env, "SHEETS_SECRET");
const config = loadAgentConfig(env);
const llm = createGroqClient(requireEnv(env, "GROQ_API_KEY"));
const db = createDb(requireEnv(env, "SUPABASE_URL"), requireEnv(env, "SUPABASE_SERVICE_ROLE_KEY"));

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

async function resolveHandoff(handoffId: string, humanAnswer: string | null) {
  const { data, error } = await db.from("handoffs")
    .update({ status: "resolvido", resolved_at: new Date().toISOString(), human_answer: humanAnswer })
    .eq("id", handoffId).select("conversation_id").single();
  if (error) throw error;
  const resumed = await db.from("conversations").update({ paused_until: null }).eq("id", data.conversation_id);
  if (resumed.error) throw resumed.error;
}

// deno-lint-ignore no-explicit-any
const actions: Record<string, (input: any) => Promise<unknown>> = {
  async pull() {
    const date = localDate(new Date(), config.timezone);
    const [handoffs, suggestions, month, day] = await Promise.all([
      db.from("handoffs").select("id, reason, question, created_at, conversations(phone)")
        .eq("status", "aberto").order("created_at"),
      db.from("suggestions").select("id, question, answer").eq("status", "pendente").order("created_at"),
      db.from("quota_month").select("used, delivered, simulated_exhausted").eq("month", date.monthKey).maybeSingle(),
      db.from("quota_day").select("used").eq("day", date.dayKey).maybeSingle(),
    ]);
    for (const result of [handoffs, suggestions, month, day]) if (result.error) throw result.error;
    return {
      // deno-lint-ignore no-explicit-any
      handoffs: handoffs.data!.map((h: any) => ({
        id: h.id,
        phone: maskPhone(h.conversations.phone),
        reason: h.reason,
        question: h.question,
        created_at: h.created_at,
      })),
      suggestions: suggestions.data,
      quota: {
        month: date.monthKey,
        cap: config.monthlyCap,
        used: month.data?.used ?? 0,
        delivered: month.data?.delivered ?? 0,
        today: day.data?.used ?? 0,
        simulated_exhausted: month.data?.simulated_exhausted ?? false,
      },
    };
  },

  async sync_desligados({ phones }: { phones: string[] }) {
    const keys = [...new Set(phones.map(phoneKey).filter((k) => k.length >= 10))];
    const removed = await db.from("dismissed_phones").delete().neq("phone_key", "");
    if (removed.error) throw removed.error;
    if (keys.length > 0) {
      const inserted = await db.from("dismissed_phones").insert(keys.map((phone_key) => ({ phone_key })));
      if (inserted.error) throw inserted.error;
    }
    return { total: keys.length };
  },

  async learn({ handoff_id, answer }: { handoff_id: string; answer: string }) {
    if (!answer?.trim()) throw new Error("Preencha a resposta do RH antes de aprender.");
    const { data, error } = await db.from("handoffs").select("question").eq("id", handoff_id).single();
    if (error) throw error;
    const clean = maskPersonalData(answer.trim());
    const draft = await draftFaq(llm, config.answerModel, data.question, clean);
    const inserted = await db.from("suggestions").insert(draft);
    if (inserted.error) throw inserted.error;
    await resolveHandoff(handoff_id, clean);
    return draft;
  },

  async approve({ suggestion_id, question, answer }: { suggestion_id: string; question: string; answer: string }) {
    const { data: pending, error } = await db.from("suggestions").select("status")
      .eq("id", suggestion_id).single();
    if (error) throw error;
    if (pending.status !== "pendente") return { already: true };
    const chunk = await db.from("kb_chunks").insert({
      source: "faq",
      title: "Perguntas frequentes",
      section: question,
      content: `Pergunta: ${question}\nResposta: ${answer}`,
    }).select("id").single();
    if (chunk.error) throw chunk.error;
    const updated = await db.from("suggestions")
      .update({ status: "aprovado", question, answer, chunk_id: chunk.data.id }).eq("id", suggestion_id);
    if (updated.error) throw updated.error;
    return { chunk_id: chunk.data.id };
  },

  async reject({ suggestion_id }: { suggestion_id: string }) {
    const { error } = await db.from("suggestions").update({ status: "rejeitado" }).eq("id", suggestion_id);
    if (error) throw error;
    return {};
  },

  async resume({ handoff_id }: { handoff_id: string }) {
    await resolveHandoff(handoff_id, null);
    return {};
  },

  async simulate_quota({ exhausted }: { exhausted: boolean }) {
    const month = localDate(new Date(), config.timezone).monthKey;
    const { error } = await db.from("quota_month")
      .upsert({ month, simulated_exhausted: exhausted === true }, { onConflict: "month" });
    if (error) throw error;
    return { exhausted: exhausted === true };
  },
};

Deno.serve(async (request) => {
  if (request.method !== "POST") return json({ error: "Método não permitido" }, 405);
  if (request.headers.get("x-sheets-secret") !== secret) return json({ error: "Não autorizado" }, 401);

  const input = await request.json();
  const action = Object.hasOwn(actions, input.action) ? actions[input.action] : null;
  if (!action) return json({ error: "Ação desconhecida" }, 400);

  try {
    return json(await action(input));
  } catch (error) {
    console.error(`Falha em ${input.action}`, error);
    return json({ error: error instanceof Error ? error.message : "Erro interno" }, 500);
  }
});
