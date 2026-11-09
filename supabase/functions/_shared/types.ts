export type Intent =
  | "duvida_rh"
  | "ex_funcionario"
  | "sensivel"
  | "dado_individual"
  | "fora_escopo"
  | "saudacao";

export type HandoffReason =
  | "sensivel"
  | "anexo"
  | "dado_individual"
  | "sem_resposta"
  | "falha_llm"
  | "sem_cota";

export type TurnAction =
  | "silencio_humano"
  | "desligado"
  | "desligado_repetido"
  | "sem_cota"
  | "transferido"
  | "saudacao"
  | "fora_escopo"
  | "resposta";

export interface Conversation {
  id: string;
  phone: string;
  pausedUntil: Date | null;
  lastFixedReplyAt: Date | null;
}

export interface Turn {
  conversation: Conversation;
  text: string;
  hasAttachment: boolean;
}

export interface HistoryItem {
  role: "user" | "assistant";
  text: string;
}

export interface KbChunk {
  id: number;
  title: string;
  section: string;
  content: string;
}

export interface QuotaState {
  usedMonth: number;
  usedToday: number;
  simulatedExhausted: boolean;
}

export interface OutboundRecord {
  conversationId: string;
  waMessageId: string;
  kind: string;
  body: string;
  retrieved?: number[];
  promptVersion?: string;
}

export interface InboundRow {
  id: string;
  kind: string;
  body: string | null;
  mediaId: string | null;
  createdAt: string;
}

export interface Store {
  isDismissed(phoneKey: string): Promise<boolean>;
  history(conversationId: string, limit: number): Promise<HistoryItem[]>;
  hasOutboundSince(conversationId: string, since: Date): Promise<boolean>;
  hasAnyOutbound(conversationId: string): Promise<boolean>;
  quotaState(month: string, day: string): Promise<QuotaState>;
  reserveQuota(month: string, day: string, monthlyCap: number, dailyLimit: number): Promise<boolean>;
  releaseQuota(month: string, day: string): Promise<void>;
  saveOutbound(record: OutboundRecord): Promise<void>;
  openHandoff(conversationId: string, reason: HandoffReason, question: string): Promise<boolean>;
  pause(conversationId: string, until: Date): Promise<void>;
  markFixedReply(conversationId: string, at: Date): Promise<void>;
  searchKb(query: string, keywords: string[], limit: number): Promise<KbChunk[]>;
  logEvent(conversationId: string, action: string, detail: Record<string, unknown>): Promise<void>;
}

export interface WhatsAppSender {
  sendText(to: string, body: string): Promise<string>;
}

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface LlmClient {
  completeJson(model: string, messages: ChatMessage[], maxTokens: number): Promise<Record<string, unknown>>;
}

export interface AgentConfig {
  companyName: string;
  dismissalEmail: string;
  monthlyCap: number;
  timezone: string;
  routerModel: string;
  answerModel: string;
}

export interface AgentDeps {
  store: Store;
  whatsapp: WhatsAppSender;
  llm: LlmClient;
  config: AgentConfig;
  now: () => Date;
}

export interface TurnResult {
  action: TurnAction;
  detail?: string;
}
