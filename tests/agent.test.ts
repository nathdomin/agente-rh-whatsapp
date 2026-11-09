import assert from "node:assert/strict";
import { beforeEach, describe, test } from "node:test";
import { formerEmployeeText, HANDOFF_TEXT, handleTurn } from "../supabase/functions/_shared/agent.ts";
import { ingestMessage, processAfterDebounce } from "../supabase/functions/_shared/process.ts";
import type { PipelineDeps } from "../supabase/functions/_shared/process.ts";
import { phoneKey } from "../supabase/functions/_shared/phone.ts";
import type { ChatMessage, LlmClient } from "../supabase/functions/_shared/types.ts";
import { MemoryStore } from "./memory-store.ts";

const PHONE = "5511987654321";
const NOW = new Date("2026-11-10T15:00:00Z");

let store: MemoryStore;
let sent: { to: string; body: string }[];
let llmCalls: ChatMessage[][];
let routerReply: Record<string, unknown>;
let answerReply: Record<string, unknown>;
let llmError: Error | null;
let deps: PipelineDeps;

const llm: LlmClient = {
  async completeJson(model, messages) {
    llmCalls.push(messages);
    if (llmError) throw llmError;
    return model === "router" ? routerReply : answerReply;
  },
};

beforeEach(() => {
  store = new MemoryStore();
  store.chunks = [{ id: 1, title: "Crachá", section: "Segunda via", content: "Peça a segunda via no portal." }];
  sent = [];
  llmCalls = [];
  llmError = null;
  routerReply = { intent: "duvida_rh", question: "Como pedir segunda via do crachá?", keywords: ["crachá"] };
  answerReply = { answerable: true, answer: "Peça no portal.", sources: [1] };
  deps = {
    store,
    whatsapp: {
      async sendText(to, body) {
        sent.push({ to, body });
        return `wamid.${sent.length}`;
      },
    },
    llm,
    config: {
      companyName: "Empresa Exemplo",
      dismissalEmail: "rh@empresa-exemplo.example",
      monthlyCap: 950,
      timezone: "America/Sao_Paulo",
      routerModel: "router",
      answerModel: "answer",
    },
    now: () => NOW,
    sleep: async () => {},
    transcribe: async () => "quanto é o vale refeição",
  };
});

async function say(text: string, hasAttachment = false) {
  const conversation = await store.upsertConversation(PHONE);
  await store.saveInbound(conversation.id, {
    waMessageId: `in-${store.messages.length}`,
    phone: PHONE,
    kind: hasAttachment ? "image" : "text",
    text,
    mediaId: null,
  });
  return handleTurn(deps, { conversation, text, hasAttachment });
}

describe("fluxo normal", () => {
  test("responde usando a base e se apresenta só na primeira vez", async () => {
    assert.equal((await say("como peço segunda via?")).action, "resposta");
    assert.match(sent[0].body, /assistente virtual/);
    assert.match(sent[0].body, /Peça no portal/);
    await say("e o prazo?");
    assert.equal(sent[1].body, "Peça no portal.");
  });

  test("envia o histórico ao modelo para entender a continuação", async () => {
    await say("como peço segunda via?");
    await say("precisa de qual documento?");
    const routerPrompt = llmCalls[2][1].content;
    assert.match(routerPrompt, /Pessoa: como peço segunda via\?/);
    assert.match(routerPrompt, /RH: .*Peça no portal/s);
    assert.match(routerPrompt, /Última mensagem:\nprecisa de qual documento\?/);
  });

  test("registra os trechos usados", async () => {
    await say("como peço segunda via?");
    assert.deepEqual(store.outbound[0].retrieved, [1]);
  });
});

describe("desligados", () => {
  test("telefone na lista recebe só a resposta pronta, sem LLM", async () => {
    store.dismissed.add(phoneKey("551187654321"));
    assert.equal((await say("qual o valor do VR?")).action, "desligado");
    assert.equal(llmCalls.length, 0);
    assert.match(sent[0].body, new RegExp(formerEmployeeText("rh@empresa-exemplo.example")));
  });

  test("quem diz que foi desligado recebe a resposta pronta, sem LLM", async () => {
    assert.equal((await say("fui desligado semana passada")).action, "desligado");
    assert.equal(llmCalls.length, 0);
  });

  test("não repete a resposta pronta em 7 dias", async () => {
    await say("fui desligado semana passada");
    assert.equal((await say("fui desligado, e agora?")).action, "desligado_repetido");
    assert.equal(sent.length, 1);
  });

  test("segue a classificação do modelo quando as regras não pegam", async () => {
    routerReply = { intent: "ex_funcionario", question: "x", keywords: [] };
    assert.equal((await say("trabalhei aí até março")).action, "desligado");
  });

  test("pedido de demissão segue o fluxo normal", async () => {
    assert.equal((await say("como peço demissão?")).action, "resposta");
  });
});

describe("passagem para humano", () => {
  test("tema sensível não passa pelo modelo e pausa a IA", async () => {
    const result = await say("estou sofrendo assédio");
    assert.deepEqual([result.action, result.detail], ["transferido", "sensivel"]);
    assert.equal(llmCalls.length, 0);
    assert.match(sent[0].body, new RegExp(HANDOFF_TEXT));
    assert.ok(store.conversations.get(PHONE)!.pausedUntil! > NOW);
  });

  test("anexos vão para humano", async () => {
    assert.equal((await say("[image enviado]", true)).detail, "anexo");
  });

  test("dado individual vai para humano", async () => {
    routerReply = { intent: "dado_individual", question: "x", keywords: [] };
    assert.equal((await say("quanto eu ganho?")).detail, "dado_individual");
  });

  test("sem trecho encontrado, não chama o gerador", async () => {
    store.chunks = [];
    assert.equal((await say("tem estacionamento?")).detail, "sem_resposta");
    assert.equal(llmCalls.length, 1);
  });

  test("modelo sem resposta nos trechos vai para humano", async () => {
    answerReply = { answerable: false, answer: "", sources: [] };
    assert.equal((await say("tem estacionamento?")).detail, "sem_resposta");
  });

  test("resposta citando trecho inexistente não é enviada", async () => {
    answerReply = { answerable: true, answer: "Sim, há vagas.", sources: [99] };
    assert.equal((await say("tem estacionamento?")).detail, "sem_resposta");
    assert.ok(!sent.some((m) => m.body.includes("há vagas")));
  });

  test("durante a pausa a IA fica em silêncio", async () => {
    await say("estou sofrendo assédio");
    const before = sent.length;
    assert.equal((await say("alguém aí?")).action, "silencio_humano");
    assert.equal(sent.length, before);
  });

  test("falha do modelo vai para a fila sem enviar nada e sem pausar", async () => {
    llmError = new Error("429");
    const result = await say("como peço férias?");
    assert.match(result.detail!, /falha_llm/);
    assert.equal(sent.length, 0);
    assert.equal(store.conversations.get(PHONE)!.pausedUntil, null);
  });
});

describe("cota", () => {
  test("cota esgotada: não chama o modelo, não envia e registra na fila", async () => {
    store.quota.usedMonth = 950;
    assert.equal((await say("como peço férias?")).action, "sem_cota");
    assert.equal(llmCalls.length, 0);
    assert.equal(sent.length, 0);
    assert.equal(store.handoffs[0].reason, "sem_cota");
  });

  test("simulação de cota esgotada bloqueia o envio", async () => {
    store.quota.simulatedExhausted = true;
    assert.equal((await say("como peço férias?")).action, "sem_cota");
    assert.equal(sent.length, 0);
  });

  test("cada envio consome uma mensagem", async () => {
    await say("como peço segunda via?");
    assert.equal(store.quota.usedMonth, 1);
  });

  test("falha no envio devolve a cota", async () => {
    const failure = new Error("falhou");
    failure.name = "WhatsAppError";
    deps.whatsapp.sendText = async () => {
      throw failure;
    };
    await assert.rejects(say("como peço segunda via?"));
    assert.equal(store.quota.usedMonth, 0);
  });
});

describe("recepção", () => {
  const message = (id: string, text: string) => ({
    waMessageId: id,
    phone: PHONE,
    kind: "text",
    text,
    mediaId: null,
  });

  test("mensagem reenviada pela Meta é ignorada", async () => {
    assert.ok(await ingestMessage(store, message("a", "oi")));
    assert.equal(await ingestMessage(store, message("a", "oi")), null);
  });

  test("não guarda CPF", async () => {
    await ingestMessage(store, message("a", "meu cpf 123.456.789-00"));
    assert.equal(store.messages[0].body, "meu cpf [CPF]");
  });

  test("junta mensagens seguidas em uma resposta só", async () => {
    const first = await ingestMessage(store, message("a", "bom dia"));
    const second = await ingestMessage(store, message("b", "como peço segunda via?"));
    assert.equal(await processAfterDebounce(deps, first!.conversationId, first!.messageId), null);
    const result = await processAfterDebounce(deps, second!.conversationId, second!.messageId);
    assert.equal(result!.action, "resposta");
    assert.equal(sent.length, 1);
    assert.match(llmCalls[0][1].content, /bom dia\ncomo peço segunda via\?/);
  });

  test("transcreve áudio e responde", async () => {
    const saved = await ingestMessage(store, { waMessageId: "a", phone: PHONE, kind: "audio", text: null, mediaId: "m1" });
    const result = await processAfterDebounce(deps, saved!.conversationId, saved!.messageId);
    assert.equal(result!.action, "resposta");
    assert.equal(store.messages[0].body, "quanto é o vale refeição");
  });

  test("áudio que falha vai para humano", async () => {
    deps.transcribe = async () => {
      throw new Error("falhou");
    };
    const saved = await ingestMessage(store, { waMessageId: "a", phone: PHONE, kind: "audio", text: null, mediaId: "m1" });
    const result = await processAfterDebounce(deps, saved!.conversationId, saved!.messageId);
    assert.equal(result!.detail, "anexo");
  });
});
