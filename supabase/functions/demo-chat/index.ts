// Conversa de demonstração sem a Meta: usa o mesmo agente, banco e busca do webhook,
// mas devolve a resposta na requisição em vez de enviá-la pelo WhatsApp.
import { loadAgentConfig, requireEnv } from "../_shared/config.ts";
import { createGroqClient, transcribeAudio } from "../_shared/llm.ts";
import { phoneKey } from "../_shared/phone.ts";
import { ingestMessage, processAfterDebounce } from "../_shared/process.ts";
import type { PipelineDeps } from "../_shared/process.ts";
import { createDb, createSupabaseStore } from "../_shared/supabase-store.ts";

const env = (name: string) => Deno.env.get(name);

const secret = requireEnv(env, "SHEETS_SECRET");
const groqKey = requireEnv(env, "GROQ_API_KEY");
const config = loadAgentConfig(env);
const llm = createGroqClient(groqKey);
const db = createDb(requireEnv(env, "SUPABASE_URL"), requireEnv(env, "SUPABASE_SERVICE_ROLE_KEY"));
const store = createSupabaseStore(db);

// Telefones fictícios: só esta faixa pode conversar por aqui.
const DEMO_PHONE = /^55009\d{8}$/;
const DISMISSED_DEMO_PHONE = "5500900000002";
const MAX_AUDIO_BASE64 = 4_000_000;

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function decodeBase64(value: string): Uint8Array<ArrayBuffer> {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function checked(result: PromiseLike<{ error: { message: string } | null }>) {
  const { error } = await result;
  if (error) throw new Error(error.message);
}

async function reset() {
  await checked(db.from("conversations").delete().like("phone", "55009%"));
  await checked(db.from("suggestions").delete().neq("status", "inexistente"));
  await checked(db.from("kb_chunks").delete().eq("source", "faq"));
  await checked(db.from("quota_month").delete().neq("month", ""));
  await checked(db.from("quota_day").delete().neq("day", ""));
}

async function chat(input: { phone?: string; text?: string; kind?: string; audio?: string; audioType?: string }) {
  const phone = input.phone ?? "";
  const kind = input.kind ?? "text";
  if (!DEMO_PHONE.test(phone)) return json({ error: "Telefone fora da faixa de demonstração" }, 400);
  if (!["text", "audio", "image"].includes(kind)) return json({ error: "Tipo de mensagem inválido" }, 400);
  if (kind === "text" && !input.text?.trim()) return json({ error: "Mensagem vazia" }, 400);
  if (kind === "audio" && (!input.audio || input.audio.length > MAX_AUDIO_BASE64)) {
    return json({ error: "Áudio ausente ou longo demais" }, 400);
  }

  if (phone === DISMISSED_DEMO_PHONE) {
    await checked(db.from("dismissed_phones").upsert({ phone_key: phoneKey(phone) }, { onConflict: "phone_key" }));
  }

  const replies: string[] = [];
  let transcript: string | null = null;

  const deps: PipelineDeps = {
    store,
    llm,
    config,
    now: () => new Date(),
    sleep: () => Promise.resolve(),
    whatsapp: {
      sendText(_to: string, body: string) {
        replies.push(body);
        return Promise.resolve(`demo-out-${crypto.randomUUID()}`);
      },
    },
    transcribe: async () => {
      const audio = new Blob([decodeBase64(input.audio!)], { type: input.audioType ?? "audio/webm" });
      transcript = await transcribeAudio(groqKey, audio, fetch, "audio.webm");
      return transcript;
    },
  };

  const saved = await ingestMessage(store, {
    waMessageId: `demo-in-${crypto.randomUUID()}`,
    phone,
    kind,
    text: kind === "text" ? input.text!.trim() : null,
    mediaId: kind === "audio" ? "demo" : null,
  });
  const result = saved ? await processAfterDebounce(deps, saved.conversationId, saved.messageId) : null;
  return json({ replies, action: result?.action ?? null, detail: result?.detail ?? null, transcript });
}

Deno.serve(async (request) => {
  if (request.method !== "POST") return json({ error: "Método não permitido" }, 405);
  if (request.headers.get("x-demo-secret") !== secret) return json({ error: "Não autorizado" }, 401);

  try {
    const input = await request.json();
    if (input.action === "reset") {
      await reset();
      return json({ ok: true });
    }
    return await chat(input);
  } catch (error) {
    console.error("Falha na demonstração", error);
    return json({ error: error instanceof Error ? error.message : "Erro interno" }, 500);
  }
});
