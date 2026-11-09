import type { WhatsAppSender } from "./types.ts";
import { alternatePhone } from "./phone.ts";

const GRAPH_BASE = "https://graph.facebook.com";
// Código da Meta para "destinatário fora da lista permitida" do número de teste.
const NOT_ALLOWED_RECIPIENT = 131030;

export class WhatsAppError extends Error {
  code: number | null;
  constructor(message: string, code: number | null) {
    super(message);
    this.name = "WhatsAppError";
    this.code = code;
  }
}

export interface WhatsAppOptions {
  token: string;
  phoneNumberId: string;
  graphVersion: string;
  fetchFn?: typeof fetch;
}

export function createWhatsAppClient(options: WhatsAppOptions): WhatsAppSender & {
  downloadMedia(mediaId: string): Promise<Blob>;
} {
  const { token, phoneNumberId, graphVersion } = options;
  const fetchFn = options.fetchFn ?? fetch;
  const headers = { "Authorization": `Bearer ${token}` };

  async function sendOnce(to: string, body: string): Promise<string> {
    const response = await fetchFn(`${GRAPH_BASE}/${graphVersion}/${phoneNumberId}/messages`, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({
        messaging_product: "whatsapp",
        to,
        type: "text",
        text: { body, preview_url: false },
      }),
    });
    const data = await response.json();
    if (!response.ok) {
      throw new WhatsAppError(data?.error?.message ?? `Erro ${response.status}`, data?.error?.code ?? null);
    }
    return data.messages[0].id;
  }

  return {
    async sendText(to: string, body: string) {
      try {
        return await sendOnce(to, body);
      } catch (error) {
        // O webhook pode trazer o número sem o 9º dígito, diferente do cadastrado na lista de teste.
        const alternate = alternatePhone(to);
        if (error instanceof WhatsAppError && error.code === NOT_ALLOWED_RECIPIENT && alternate) {
          return await sendOnce(alternate, body);
        }
        throw error;
      }
    },

    async downloadMedia(mediaId: string) {
      const info = await fetchFn(`${GRAPH_BASE}/${graphVersion}/${mediaId}`, { headers });
      if (!info.ok) throw new WhatsAppError(`Mídia indisponível (${info.status})`, null);
      const { url } = await info.json();
      const file = await fetchFn(url, { headers });
      if (!file.ok) throw new WhatsAppError(`Falha ao baixar mídia (${file.status})`, null);
      return await file.blob();
    },
  };
}
