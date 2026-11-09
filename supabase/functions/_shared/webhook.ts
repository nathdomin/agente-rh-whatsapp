export async function verifySignature(appSecret: string, rawBody: string, header: string | null): Promise<boolean> {
  if (!header?.startsWith("sha256=")) return false;
  const signature = hexToBytes(header.slice("sha256=".length));
  if (!signature) return false;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(appSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );
  return crypto.subtle.verify("HMAC", key, signature as BufferSource, new TextEncoder().encode(rawBody));
}

function hexToBytes(hex: string): Uint8Array | null {
  if (hex.length !== 64 || !/^[0-9a-f]+$/i.test(hex)) return null;
  const bytes = new Uint8Array(32);
  for (let i = 0; i < 32; i++) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return bytes;
}

export interface ParsedMessage {
  waMessageId: string;
  phone: string;
  kind: string;
  text: string | null;
  mediaId: string | null;
}

export interface ParsedReaction {
  targetWaMessageId: string;
  emoji: string;
}

export interface ParsedStatus {
  waMessageId: string;
  status: string;
  error?: { code: number; title: string; details: string | null };
}

export interface ParsedWebhook {
  messages: ParsedMessage[];
  reactions: ParsedReaction[];
  statuses: ParsedStatus[];
}

// deno-lint-ignore no-explicit-any
export function parseWebhook(payload: any): ParsedWebhook {
  const result: ParsedWebhook = { messages: [], reactions: [], statuses: [] };
  for (const entry of payload?.entry ?? []) {
    for (const change of entry?.changes ?? []) {
      const value = change?.value;
      for (const status of value?.statuses ?? []) {
        const error = status.errors?.[0];
        result.statuses.push({
          waMessageId: status.id,
          status: status.status,
          ...(error && {
            error: { code: error.code, title: error.title, details: error.error_data?.details ?? error.message ?? null },
          }),
        });
      }
      for (const message of value?.messages ?? []) {
        if (message.type === "reaction") {
          result.reactions.push({
            targetWaMessageId: message.reaction?.message_id,
            emoji: message.reaction?.emoji ?? "",
          });
          continue;
        }
        result.messages.push({
          waMessageId: message.id,
          phone: message.from,
          kind: message.type,
          text: message.type === "text" ? message.text?.body ?? "" : null,
          mediaId: message[message.type]?.id ?? null,
        });
      }
    }
  }
  return result;
}
