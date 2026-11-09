import type { ChatMessage, LlmClient } from "./types.ts";

const GROQ_BASE = "https://api.groq.com/openai/v1";
const REQUEST_TIMEOUT_MS = 20_000;

export class LlmError extends Error {}

/** Extrai o primeiro objeto JSON do texto, ignorando o que vier em volta. */
export function parseJsonObject(text: string): Record<string, unknown> {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end <= start) throw new LlmError("Resposta do modelo sem JSON");
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    throw new LlmError("JSON inválido na resposta do modelo");
  }
}

export function createGroqClient(apiKey: string, fetchFn: typeof fetch = fetch): LlmClient {
  return {
    async completeJson(model: string, messages: ChatMessage[], maxTokens: number) {
      const response = await fetchFn(`${GROQ_BASE}/chat/completions`, {
        method: "POST",
        headers: { "Authorization": `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          model,
          messages,
          max_completion_tokens: maxTokens,
          response_format: { type: "json_object" },
        }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (!response.ok) {
        throw new LlmError(`Groq respondeu ${response.status}: ${(await response.text()).slice(0, 300)}`);
      }
      const data = await response.json();
      const content = data?.choices?.[0]?.message?.content;
      if (typeof content !== "string") throw new LlmError("Groq não devolveu texto");
      return parseJsonObject(content);
    },
  };
}

export async function transcribeAudio(
  apiKey: string,
  audio: Blob,
  fetchFn: typeof fetch = fetch,
  fileName = "audio.ogg",
): Promise<string> {
  const form = new FormData();
  form.append("file", audio, fileName);
  form.append("model", "whisper-large-v3-turbo");
  form.append("language", "pt");
  const response = await fetchFn(`${GROQ_BASE}/audio/transcriptions`, {
    method: "POST",
    headers: { "Authorization": `Bearer ${apiKey}` },
    body: form,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!response.ok) throw new LlmError(`Whisper respondeu ${response.status}`);
  const data = await response.json();
  if (typeof data?.text !== "string") throw new LlmError("Whisper não devolveu texto");
  return data.text;
}
