import { loadAgentConfig, requireEnv } from "../_shared/config.ts";
import { createGroqClient, transcribeAudio } from "../_shared/llm.ts";
import { ingestMessage, processAfterDebounce } from "../_shared/process.ts";
import type { PipelineDeps } from "../_shared/process.ts";
import { localDate } from "../_shared/quota.ts";
import { createDb, createSupabaseStore } from "../_shared/supabase-store.ts";
import { parseWebhook, verifySignature } from "../_shared/webhook.ts";
import { createWhatsAppClient } from "../_shared/whatsapp.ts";

declare const EdgeRuntime: { waitUntil(promise: Promise<unknown>): void };

const env = (name: string) => Deno.env.get(name);

const verifyToken = requireEnv(env, "META_VERIFY_TOKEN");
const appSecret = requireEnv(env, "META_APP_SECRET");
const groqKey = requireEnv(env, "GROQ_API_KEY");
const config = loadAgentConfig(env);

const db = createDb(requireEnv(env, "SUPABASE_URL"), requireEnv(env, "SUPABASE_SERVICE_ROLE_KEY"));
const store = createSupabaseStore(db);
const whatsapp = createWhatsAppClient({
  token: requireEnv(env, "META_ACCESS_TOKEN"),
  phoneNumberId: requireEnv(env, "META_PHONE_NUMBER_ID"),
  graphVersion: env("META_GRAPH_VERSION") ?? "v23.0",
});

const deps: PipelineDeps = {
  store,
  whatsapp,
  llm: createGroqClient(groqKey),
  config,
  now: () => new Date(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  transcribe: async (mediaId) => transcribeAudio(groqKey, await whatsapp.downloadMedia(mediaId)),
};

async function recordStatus(waMessageId: string, status: string) {
  if (status !== "delivered" && status !== "read" && status !== "failed") return;
  const update = db.from("messages").update({ status }).eq("wa_message_id", waMessageId);
  // Só a primeira confirmação de entrega conta na cota.
  if (status === "delivered") {
    const { data, error } = await update.eq("status", "sent").select("id");
    if (error) throw error;
    if (data.length > 0) {
      await db.rpc("count_delivered", { p_month: localDate(new Date(), config.timezone).monthKey });
    }
    return;
  }
  const { error } = await update;
  if (error) throw error;
}

Deno.serve(async (request) => {
  const url = new URL(request.url);

  if (request.method === "GET") {
    const valid = url.searchParams.get("hub.mode") === "subscribe" &&
      url.searchParams.get("hub.verify_token") === verifyToken;
    return valid
      ? new Response(url.searchParams.get("hub.challenge") ?? "", { status: 200 })
      : new Response("Forbidden", { status: 403 });
  }

  if (request.method !== "POST") return new Response("Method Not Allowed", { status: 405 });

  const rawBody = await request.text();
  if (!(await verifySignature(appSecret, rawBody, request.headers.get("x-hub-signature-256")))) {
    return new Response("Invalid signature", { status: 401 });
  }

  const parsed = parseWebhook(JSON.parse(rawBody));

  for (const status of parsed.statuses) {
    await recordStatus(status.waMessageId, status.status);
    if (status.error) {
      console.error("Falha na entrega", status.error);
      await db.from("agent_events").insert({ action: "falha_entrega", detail: status.error });
    }
  }

  for (const reaction of parsed.reactions) {
    await db.from("messages").update({ reaction: reaction.emoji }).eq("wa_message_id", reaction.targetWaMessageId);
  }

  for (const message of parsed.messages) {
    const saved = await ingestMessage(store, message);
    if (!saved) continue;
    EdgeRuntime.waitUntil(
      processAfterDebounce(deps, saved.conversationId, saved.messageId).catch((error) => {
        console.error("Falha ao processar mensagem", error);
      }),
    );
  }

  return new Response("ok", { status: 200 });
});
