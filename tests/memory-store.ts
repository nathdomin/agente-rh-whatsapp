import type {
  Conversation,
  HandoffReason,
  HistoryItem,
  InboundRow,
  KbChunk,
  OutboundRecord,
  QuotaState,
} from "../supabase/functions/_shared/types.ts";
import type { PipelineStore } from "../supabase/functions/_shared/process.ts";
import type { ParsedMessage } from "../supabase/functions/_shared/webhook.ts";
import { normalize } from "../supabase/functions/_shared/router.ts";

interface StoredMessage extends InboundRow {
  waMessageId: string;
  conversationId: string;
  direction: "in" | "out";
  processed: boolean;
}

/** Armazenamento em memória para testes e avaliação local. */
export class MemoryStore implements PipelineStore {
  conversations = new Map<string, Conversation>();
  messages: StoredMessage[] = [];
  dismissed = new Set<string>();
  chunks: KbChunk[] = [];
  handoffs: { conversationId: string; reason: HandoffReason; question: string }[] = [];
  outbound: OutboundRecord[] = [];
  events: { action: string; detail: Record<string, unknown> }[] = [];
  quota: QuotaState = { usedMonth: 0, usedToday: 0, simulatedExhausted: false };
  private clock = 0;

  async upsertConversation(phone: string) {
    const existing = this.conversations.get(phone);
    if (existing) return existing;
    const conversation: Conversation = { id: phone, phone, pausedUntil: null, lastFixedReplyAt: null };
    this.conversations.set(phone, conversation);
    return conversation;
  }

  async getConversation(id: string) {
    return this.conversations.get(id)!;
  }

  private push(row: Omit<StoredMessage, "createdAt" | "id">) {
    const id = `m${this.messages.length + 1}`;
    this.clock++;
    this.messages.push({ ...row, id, createdAt: String(this.clock).padStart(8, "0") });
    return id;
  }

  async saveInbound(conversationId: string, message: ParsedMessage) {
    if (this.messages.some((m) => m.waMessageId === message.waMessageId)) return null;
    const id = this.push({
      waMessageId: message.waMessageId,
      conversationId,
      direction: "in",
      processed: false,
      kind: message.kind,
      body: message.text,
      mediaId: message.mediaId,
    });
    return { id };
  }

  async latestInboundId(conversationId: string) {
    const rows = this.messages.filter((m) => m.conversationId === conversationId && m.direction === "in");
    return rows.at(-1)?.id ?? null;
  }

  async claimInbound(conversationId: string) {
    const rows = this.messages.filter((m) => m.conversationId === conversationId && m.direction === "in" && !m.processed);
    rows.forEach((m) => (m.processed = true));
    return rows;
  }

  async updateBody(id: string, body: string) {
    this.messages.find((m) => m.id === id)!.body = body;
  }

  async isDismissed(key: string) {
    return this.dismissed.has(key);
  }

  async history(conversationId: string, limit: number): Promise<HistoryItem[]> {
    return this.messages
      .filter((m) => m.conversationId === conversationId && m.body)
      .slice(-limit)
      .map((m) => ({ role: m.direction === "in" ? "user" : "assistant", text: m.body! }));
  }

  async hasOutboundSince(conversationId: string, _since: Date) {
    return this.outbound.some((o) => o.conversationId === conversationId);
  }

  async hasAnyOutbound(conversationId: string) {
    return this.outbound.some((o) => o.conversationId === conversationId);
  }

  async quotaState() {
    return { ...this.quota };
  }

  async reserveQuota(_month: string, _day: string, monthlyCap: number, dailyLimit: number) {
    if (this.quota.usedMonth >= monthlyCap || this.quota.usedToday >= dailyLimit) return false;
    this.quota.usedMonth++;
    this.quota.usedToday++;
    return true;
  }

  async releaseQuota() {
    this.quota.usedMonth--;
    this.quota.usedToday--;
  }

  async saveOutbound(record: OutboundRecord) {
    this.outbound.push(record);
    this.push({
      waMessageId: record.waMessageId,
      conversationId: record.conversationId,
      direction: "out",
      processed: true,
      kind: record.kind,
      body: record.body,
      mediaId: null,
    });
  }

  async openHandoff(conversationId: string, reason: HandoffReason, question: string) {
    if (this.handoffs.some((h) => h.conversationId === conversationId)) return false;
    this.handoffs.push({ conversationId, reason, question });
    return true;
  }

  async pause(conversationId: string, until: Date) {
    this.conversations.get(conversationId)!.pausedUntil = until;
  }

  async markFixedReply(conversationId: string, at: Date) {
    this.conversations.get(conversationId)!.lastFixedReplyAt = at;
  }

  async searchKb(query: string, keywords: string[], limit: number) {
    const terms = normalize(`${query} ${keywords.join(" ")}`).split(/\W+/).filter((t) => t.length > 3);
    return this.chunks
      .map((chunk) => {
        const haystack = normalize(`${chunk.title} ${chunk.section} ${chunk.content}`);
        return { chunk, score: terms.filter((t) => haystack.includes(t)).length };
      })
      .filter((item) => item.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map((item) => item.chunk);
  }

  async logEvent(_conversationId: string, action: string, detail: Record<string, unknown>) {
    this.events.push({ action, detail });
  }
}
