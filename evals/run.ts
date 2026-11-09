// Executa o conjunto de perguntas com o modelo real, sem enviar nada pelo WhatsApp.
// Usa os documentos locais e, se SUPABASE_URL estiver definido, a busca real do banco.
// Uso: npm run eval             (todas)
//      npm run eval -- vr-valor (uma)
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { handleTurn } from "../supabase/functions/_shared/agent.ts";
import { chunkMarkdown } from "../supabase/functions/_shared/chunk.ts";
import { loadAgentConfig, requireEnv } from "../supabase/functions/_shared/config.ts";
import { createGroqClient } from "../supabase/functions/_shared/llm.ts";
import { phoneKey } from "../supabase/functions/_shared/phone.ts";
import { normalize } from "../supabase/functions/_shared/router.ts";
import type { KbChunk } from "../supabase/functions/_shared/types.ts";
import { MemoryStore } from "../tests/memory-store.ts";

interface Case {
  id: string;
  turns: string[];
  action?: string;
  actionNot?: string;
  reason?: string;
  mustInclude?: string[];
  dismissed?: boolean;
}

const PHONE = "5511900000000";
const PAUSE_BETWEEN_TURNS_MS = 2_500;

const root = join(import.meta.dirname, "..");
const env = (name: string) => process.env[name];
const llm = createGroqClient(requireEnv(env, "GROQ_API_KEY"));
const config = loadAgentConfig(env);

const cases: Case[] = JSON.parse(readFileSync(join(root, "evals/questions.json"), "utf8"));
const only = process.argv.slice(2);
const selected = only.length > 0 ? cases.filter((c) => only.includes(c.id)) : cases;

const localChunks: KbChunk[] = readdirSync(join(root, "knowledge"))
  .flatMap((file) => chunkMarkdown(readFileSync(join(root, "knowledge", file), "utf8")))
  .map((chunk, index) => ({ id: index + 1, ...chunk }));

async function remoteSearch(query: string, keywords: string[], limit: number): Promise<KbChunk[]> {
  const url = env("SUPABASE_URL")!;
  const key = requireEnv(env, "SUPABASE_SERVICE_ROLE_KEY");
  const response = await fetch(`${url}/rest/v1/rpc/search_kb`, {
    method: "POST",
    headers: { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ p_query: query, p_keywords: keywords, p_limit: limit }),
  });
  if (!response.ok) throw new Error(`Busca falhou: ${await response.text()}`);
  return response.json();
}

async function runCase(testCase: Case) {
  const store = new MemoryStore();
  store.chunks = localChunks;
  if (env("SUPABASE_URL")) store.searchKb = remoteSearch;
  if (testCase.dismissed) store.dismissed.add(phoneKey(PHONE));

  let lastAnswer = "";
  const deps = {
    store,
    llm,
    config,
    now: () => new Date(),
    whatsapp: {
      async sendText(_to: string, body: string) {
        lastAnswer = body;
        return `eval-${store.outbound.length}`;
      },
    },
  };

  const conversation = await store.upsertConversation(PHONE);
  let result = { action: "", detail: undefined as string | undefined };
  for (const [index, text] of testCase.turns.entries()) {
    await store.saveInbound(conversation.id, {
      waMessageId: `${testCase.id}-${index}`,
      phone: PHONE,
      kind: "text",
      text,
      mediaId: null,
    });
    result = await handleTurn(deps, { conversation, text, hasAttachment: false });
    await new Promise((resolve) => setTimeout(resolve, PAUSE_BETWEEN_TURNS_MS));
  }

  const problems: string[] = [];
  if (testCase.action && result.action !== testCase.action) {
    problems.push(`ação ${result.action} (${result.detail ?? "-"}), esperada ${testCase.action}`);
  }
  if (testCase.actionNot && result.action === testCase.actionNot) problems.push(`ação proibida ${result.action}`);
  if (testCase.reason && result.detail !== testCase.reason) {
    problems.push(`motivo ${result.detail ?? "-"}, esperado ${testCase.reason}`);
  }
  // O modelo às vezes usa espaços e hífens tipográficos, que não mudam o conteúdo.
  const answerText = normalize(lastAnswer).replace(/[   ]/g, " ").replace(/[‐-―]/g, "-");
  for (const term of testCase.mustInclude ?? []) {
    if (!answerText.includes(normalize(term))) problems.push(`resposta sem "${term}"`);
  }
  return { problems, lastAnswer };
}

let passed = 0;
let invented = 0;
for (const testCase of selected) {
  const { problems, lastAnswer } = await runCase(testCase);
  if (problems.length === 0) {
    passed++;
    console.log(`OK    ${testCase.id}`);
  } else {
    // Pergunta sem resposta nos documentos que recebeu resposta: o erro mais grave.
    if (testCase.reason === "sem_resposta" && problems.some((p) => p.includes("ação resposta"))) invented++;
    console.log(`FALHA ${testCase.id}: ${problems.join("; ")}\n      resposta: ${lastAnswer || "(nenhuma)"}`);
  }
}

const accuracy = Math.round((passed / selected.length) * 100);
console.log(`\nResultado: ${passed}/${selected.length} (${accuracy}%). Regras inventadas: ${invented}.`);
console.log(`Metas: 85% de acerto e zero regras inventadas. Modelos: ${config.routerModel} e ${config.answerModel}.`);
process.exitCode = accuracy >= 85 && invented === 0 ? 0 : 1;
