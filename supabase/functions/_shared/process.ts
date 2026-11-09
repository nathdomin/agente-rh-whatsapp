import type { AgentDeps, Conversation, InboundRow, Store, TurnResult } from "./types.ts";
import type { ParsedMessage } from "./webhook.ts";
import { handleTurn } from "./agent.ts";
import { maskPersonalData } from "./privacy.ts";

export const DEBOUNCE_MS = 8_000;

const ATTACHMENT_KINDS = new Set(["image", "document", "video", "sticker"]);

export interface PipelineStore extends Store {
  upsertConversation(phone: string): Promise<Conversation>;
  saveInbound(conversationId: string, message: ParsedMessage): Promise<{ id: string } | null>;
  latestInboundId(conversationId: string): Promise<string | null>;
  claimInbound(conversationId: string): Promise<InboundRow[]>;
  updateBody(messageId: string, body: string): Promise<void>;
  getConversation(conversationId: string): Promise<Conversation>;
}

export interface PipelineDeps extends Omit<AgentDeps, "store"> {
  store: PipelineStore;
  transcribe(mediaId: string): Promise<string>;
  sleep(ms: number): Promise<void>;
}

/** Salva a mensagem. Devolve null se a Meta reenviou uma que já estava registrada. */
export async function ingestMessage(store: PipelineStore, message: ParsedMessage) {
  const conversation = await store.upsertConversation(message.phone);
  const masked = { ...message, text: message.text === null ? null : maskPersonalData(message.text) };
  const saved = await store.saveInbound(conversation.id, masked);
  return saved ? { conversationId: conversation.id, messageId: saved.id } : null;
}

/** Aguarda a pessoa terminar de digitar; só o processamento da última mensagem prossegue. */
export async function processAfterDebounce(
  deps: PipelineDeps,
  conversationId: string,
  messageId: string,
): Promise<TurnResult | null> {
  await deps.sleep(DEBOUNCE_MS);
  if ((await deps.store.latestInboundId(conversationId)) !== messageId) return null;

  const rows = await deps.store.claimInbound(conversationId);
  if (rows.length === 0) return null;

  const parts: string[] = [];
  let hasAttachment = false;

  for (const row of rows) {
    if (ATTACHMENT_KINDS.has(row.kind)) {
      hasAttachment = true;
      parts.push(row.body ?? `[${row.kind} enviado]`);
    } else if (row.kind === "audio" && row.mediaId) {
      try {
        const text = maskPersonalData(await deps.transcribe(row.mediaId));
        await deps.store.updateBody(row.id, text);
        parts.push(text);
      } catch {
        hasAttachment = true;
        parts.push("[áudio que não pôde ser transcrito]");
      }
    } else if (row.body) {
      parts.push(row.body);
    }
  }

  const text = parts.join("\n").trim();
  if (!text && !hasAttachment) return null;

  const conversation = await deps.store.getConversation(conversationId);
  return handleTurn(deps, { conversation, text, hasAttachment });
}
