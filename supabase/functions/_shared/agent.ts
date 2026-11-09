import type { AgentDeps, HandoffReason, HistoryItem, Turn, TurnAction, TurnResult } from "./types.ts";
import { phoneKey } from "./phone.ts";
import { businessDaysLeft, dailyLimit, localDate } from "./quota.ts";
import { isFormerEmployee, isGreeting, isSensitive, routeMessage } from "./router.ts";
import { generateAnswer, PROMPT_VERSION } from "./answer.ts";

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
const HANDOFF_PAUSE_MS = 12 * HOUR_MS;
const ONGOING_WINDOW_MS = DAY_MS;
const FIXED_REPLY_COOLDOWN_MS = 7 * DAY_MS;
const HISTORY_LIMIT = 10;
const KB_RESULTS = 4;

export function introText(companyName: string): string {
  return `Olá! Sou o assistente virtual do RH da ${companyName}.`;
}

export function formerEmployeeText(email: string): string {
  return `Para assuntos de quem já saiu da empresa, o atendimento é feito por e-mail. Por favor, escreva para ${email} informando seu nome completo e sua dúvida.`;
}

export const HANDOFF_TEXT = "Vou encaminhar sua mensagem para a equipe de RH, que dará continuidade ao atendimento.";
export const OUT_OF_SCOPE_TEXT = "Por aqui consigo ajudar apenas com assuntos de RH, como benefícios, crachá, recrutamento e férias.";
export const GREETING_TEXT = "Qual é a sua dúvida sobre benefícios, crachá, recrutamento, férias ou outro assunto de RH?";

/** O histórico inclui as mensagens do turno atual, que já foram salvas; o modelo as recebe à parte. */
function withoutCurrentTurn(history: HistoryItem[]): HistoryItem[] {
  const result = [...history];
  while (result.length > 0 && result[result.length - 1].role === "user") result.pop();
  return result;
}

export async function handleTurn(deps: AgentDeps, turn: Turn): Promise<TurnResult> {
  const result = await decide(deps, turn);
  await deps.store.logEvent(turn.conversation.id, result.action, { detail: result.detail ?? null });
  return result;
}

async function decide(deps: AgentDeps, turn: Turn): Promise<TurnResult> {
  const { store, whatsapp, llm, config, now } = deps;
  const conversation = turn.conversation;
  const at = now();

  if (conversation.pausedUntil && conversation.pausedUntil > at) return { action: "silencio_humano" };

  const priority = await store.hasOutboundSince(conversation.id, new Date(at.getTime() - ONGOING_WINDOW_MS));
  const date = localDate(at, config.timezone);

  async function currentLimit() {
    const state = await store.quotaState(date.monthKey, date.dayKey);
    const limit = dailyLimit({
      monthlyCap: config.monthlyCap,
      usedMonth: state.usedMonth,
      usedToday: state.usedToday,
      daysLeft: businessDaysLeft(date.year, date.month, date.day),
      priority,
    });
    return { state, limit };
  }

  async function send(
    kind: string,
    body: string,
    extra: { retrieved?: number[]; promptVersion?: string } = {},
  ): Promise<boolean> {
    const { state, limit } = await currentLimit();
    if (state.simulatedExhausted) return false;
    const reserved = await store.reserveQuota(date.monthKey, date.dayKey, config.monthlyCap, limit);
    if (!reserved) return false;

    const isFirst = !(await store.hasAnyOutbound(conversation.id));
    const text = isFirst ? `${introText(config.companyName)}\n\n${body}` : body;
    let waMessageId: string;
    try {
      waMessageId = await whatsapp.sendText(conversation.phone, text);
    } catch (error) {
      await store.releaseQuota(date.monthKey, date.dayKey);
      throw error;
    }
    await store.saveOutbound({ conversationId: conversation.id, waMessageId, kind, body: text, ...extra });
    return true;
  }

  async function reply(action: TurnAction, kind: string, body: string): Promise<TurnResult> {
    const sent = await send(kind, body);
    if (sent) return { action };
    await store.openHandoff(conversation.id, "sem_cota", turn.text);
    return { action: "sem_cota" };
  }

  async function handoff(reason: HandoffReason, question: string): Promise<TurnResult> {
    const isNew = await store.openHandoff(conversation.id, reason, question);
    await store.pause(conversation.id, new Date(at.getTime() + HANDOFF_PAUSE_MS));
    if (isNew) await send("transferencia", HANDOFF_TEXT);
    return { action: "transferido", detail: reason };
  }

  async function replyFormerEmployee(detail: string): Promise<TurnResult> {
    const last = conversation.lastFixedReplyAt;
    if (last && at.getTime() - last.getTime() < FIXED_REPLY_COOLDOWN_MS) {
      return { action: "desligado_repetido", detail };
    }
    const sent = await send("desligado", formerEmployeeText(config.dismissalEmail));
    if (!sent) {
      await store.openHandoff(conversation.id, "sem_cota", turn.text);
      return { action: "sem_cota", detail };
    }
    await store.markFixedReply(conversation.id, at);
    return { action: "desligado", detail };
  }

  if (await store.isDismissed(phoneKey(conversation.phone))) return replyFormerEmployee("lista");

  // Sem cota, nem gasta tokens: a mensagem fica com a equipe e nada é enviado.
  const { state, limit } = await currentLimit();
  if (state.simulatedExhausted || state.usedMonth >= config.monthlyCap || state.usedToday >= limit) {
    await store.openHandoff(conversation.id, "sem_cota", turn.text);
    return { action: "sem_cota" };
  }

  if (turn.hasAttachment) return handoff("anexo", turn.text);
  if (isSensitive(turn.text)) return handoff("sensivel", turn.text);
  if (isFormerEmployee(turn.text)) return replyFormerEmployee("mensagem");
  if (isGreeting(turn.text)) return reply("saudacao", "saudacao", GREETING_TEXT);

  try {
    const history = withoutCurrentTurn(await store.history(conversation.id, HISTORY_LIMIT));
    const route = await routeMessage(llm, config.routerModel, history, turn.text);

    switch (route.intent) {
      case "ex_funcionario":
        return replyFormerEmployee("modelo");
      case "sensivel":
        return handoff("sensivel", turn.text);
      case "dado_individual":
        return handoff("dado_individual", turn.text);
      case "fora_escopo":
        return reply("fora_escopo", "fora_escopo", OUT_OF_SCOPE_TEXT);
      case "saudacao":
        return reply("saudacao", "saudacao", GREETING_TEXT);
    }

    const chunks = await store.searchKb(route.question, route.keywords, KB_RESULTS);
    if (chunks.length === 0) return handoff("sem_resposta", route.question);

    const answer = await generateAnswer(llm, config.answerModel, config.companyName, history, route.question, chunks);
    if (!answer.answerable) return handoff("sem_resposta", route.question);

    const sent = await send("resposta", answer.answer, { retrieved: answer.sources, promptVersion: PROMPT_VERSION });
    if (sent) return { action: "resposta" };
    await store.openHandoff(conversation.id, "sem_cota", turn.text);
    return { action: "sem_cota" };
  } catch (error) {
    if (error instanceof Error && error.name === "WhatsAppError") throw error;
    // Falha ou limite do modelo: a pergunta vai para a fila e a IA continua ativa na próxima mensagem.
    await store.openHandoff(conversation.id, "falha_llm", turn.text);
    return { action: "transferido", detail: `falha_llm: ${error instanceof Error ? error.message : String(error)}` };
  }
}
