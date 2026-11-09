import { createClient } from "npm:@supabase/supabase-js@2.49.4";
import type { SupabaseClient } from "npm:@supabase/supabase-js@2.49.4";
import type {
  Conversation,
  HandoffReason,
  HistoryItem,
  InboundRow,
  KbChunk,
  OutboundRecord,
  QuotaState,
} from "./types.ts";
import type { PipelineStore } from "./process.ts";
import type { ParsedMessage } from "./webhook.ts";

const UNIQUE_VIOLATION = "23505";

export function createDb(url: string, serviceKey: string): SupabaseClient {
  return createClient(url, serviceKey, { auth: { persistSession: false } });
}

// deno-lint-ignore no-explicit-any
function toConversation(row: any): Conversation {
  return {
    id: row.id,
    phone: row.phone,
    pausedUntil: row.paused_until ? new Date(row.paused_until) : null,
    lastFixedReplyAt: row.last_fixed_reply_at ? new Date(row.last_fixed_reply_at) : null,
  };
}

function fail(context: string, error: { message: string }): never {
  throw new Error(`${context}: ${error.message}`);
}

export function createSupabaseStore(db: SupabaseClient): PipelineStore {
  async function outboundExists(conversationId: string, since?: Date): Promise<boolean> {
    let query = db.from("messages").select("id", { head: true, count: "exact" })
      .eq("conversation_id", conversationId).eq("direction", "out");
    if (since) query = query.gte("created_at", since.toISOString());
    const { count, error } = await query;
    if (error) fail("outboundExists", error);
    return (count ?? 0) > 0;
  }

  return {
    async upsertConversation(phone: string) {
      const { data, error } = await db.from("conversations")
        .upsert({ phone }, { onConflict: "phone" }).select().single();
      if (error) fail("upsertConversation", error);
      return toConversation(data);
    },

    async getConversation(conversationId: string) {
      const { data, error } = await db.from("conversations").select().eq("id", conversationId).single();
      if (error) fail("getConversation", error);
      return toConversation(data);
    },

    async saveInbound(conversationId: string, message: ParsedMessage) {
      const { data, error } = await db.from("messages").insert({
        conversation_id: conversationId,
        wa_message_id: message.waMessageId,
        direction: "in",
        kind: message.kind,
        body: message.text,
        media_id: message.mediaId,
      }).select("id").single();
      if (error?.code === UNIQUE_VIOLATION) return null;
      if (error) fail("saveInbound", error);
      return { id: data.id };
    },

    async latestInboundId(conversationId: string) {
      const { data, error } = await db.from("messages").select("id")
        .eq("conversation_id", conversationId).eq("direction", "in")
        .order("created_at", { ascending: false }).limit(1).maybeSingle();
      if (error) fail("latestInboundId", error);
      return data?.id ?? null;
    },

    async claimInbound(conversationId: string): Promise<InboundRow[]> {
      const { data, error } = await db.from("messages").update({ processed_at: new Date().toISOString() })
        .eq("conversation_id", conversationId).eq("direction", "in").is("processed_at", null)
        .select("id, kind, body, media_id, created_at");
      if (error) fail("claimInbound", error);
      return data
        .map((r) => ({ id: r.id, kind: r.kind, body: r.body, mediaId: r.media_id, createdAt: r.created_at }))
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    },

    async updateBody(messageId: string, body: string) {
      const { error } = await db.from("messages").update({ body }).eq("id", messageId);
      if (error) fail("updateBody", error);
    },

    async isDismissed(key: string) {
      const { count, error } = await db.from("dismissed_phones").select("phone_key", { head: true, count: "exact" })
        .eq("phone_key", key);
      if (error) fail("isDismissed", error);
      return (count ?? 0) > 0;
    },

    async history(conversationId: string, limit: number): Promise<HistoryItem[]> {
      const { data, error } = await db.from("messages").select("direction, body")
        .eq("conversation_id", conversationId).not("body", "is", null)
        .order("created_at", { ascending: false }).limit(limit);
      if (error) fail("history", error);
      return data.reverse().map((m) => ({ role: m.direction === "in" ? "user" : "assistant", text: m.body }));
    },

    hasOutboundSince: (conversationId: string, since: Date) => outboundExists(conversationId, since),
    hasAnyOutbound: (conversationId: string) => outboundExists(conversationId),

    async quotaState(month: string, day: string): Promise<QuotaState> {
      const [monthRow, dayRow] = await Promise.all([
        db.from("quota_month").select("used, simulated_exhausted").eq("month", month).maybeSingle(),
        db.from("quota_day").select("used").eq("day", day).maybeSingle(),
      ]);
      if (monthRow.error) fail("quotaState", monthRow.error);
      if (dayRow.error) fail("quotaState", dayRow.error);
      return {
        usedMonth: monthRow.data?.used ?? 0,
        usedToday: dayRow.data?.used ?? 0,
        simulatedExhausted: monthRow.data?.simulated_exhausted ?? false,
      };
    },

    async reserveQuota(month: string, day: string, monthlyCap: number, dailyLimit: number) {
      const { data, error } = await db.rpc("reserve_quota", {
        p_month: month,
        p_day: day,
        p_monthly_cap: monthlyCap,
        p_daily_limit: dailyLimit,
      });
      if (error) fail("reserveQuota", error);
      return data === true;
    },

    async releaseQuota(month: string, day: string) {
      const { error } = await db.rpc("release_quota", { p_month: month, p_day: day });
      if (error) fail("releaseQuota", error);
    },

    async saveOutbound(record: OutboundRecord) {
      const { error } = await db.from("messages").insert({
        conversation_id: record.conversationId,
        wa_message_id: record.waMessageId,
        direction: "out",
        kind: record.kind,
        body: record.body,
        status: "sent",
        retrieved: record.retrieved ?? null,
        prompt_version: record.promptVersion ?? null,
      });
      if (error) fail("saveOutbound", error);
    },

    async openHandoff(conversationId: string, reason: HandoffReason, question: string) {
      const { error } = await db.from("handoffs").insert({ conversation_id: conversationId, reason, question });
      if (error?.code === UNIQUE_VIOLATION) return false;
      if (error) fail("openHandoff", error);
      return true;
    },

    async pause(conversationId: string, until: Date) {
      const { error } = await db.from("conversations").update({ paused_until: until.toISOString() })
        .eq("id", conversationId);
      if (error) fail("pause", error);
    },

    async markFixedReply(conversationId: string, at: Date) {
      const { error } = await db.from("conversations").update({ last_fixed_reply_at: at.toISOString() })
        .eq("id", conversationId);
      if (error) fail("markFixedReply", error);
    },

    async searchKb(query: string, keywords: string[], limit: number): Promise<KbChunk[]> {
      const { data, error } = await db.rpc("search_kb", { p_query: query, p_keywords: keywords, p_limit: limit });
      if (error) fail("searchKb", error);
      return data;
    },

    async logEvent(conversationId: string, action: string, detail: Record<string, unknown>) {
      const { error } = await db.from("agent_events").insert({ conversation_id: conversationId, action, detail });
      if (error) fail("logEvent", error);
    },
  };
}
