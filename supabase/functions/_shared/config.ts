import type { AgentConfig } from "./types.ts";

export type GetEnv = (name: string) => string | undefined;

export function requireEnv(getEnv: GetEnv, name: string): string {
  const value = getEnv(name);
  if (!value) throw new Error(`Variável de ambiente ausente: ${name}`);
  return value;
}

export function loadAgentConfig(getEnv: GetEnv): AgentConfig {
  return {
    companyName: getEnv("COMPANY_NAME") ?? "Empresa Exemplo",
    dismissalEmail: getEnv("DISMISSAL_EMAIL") ?? "rh@empresa-exemplo.example",
    monthlyCap: Number(getEnv("MONTHLY_CAP") ?? 950),
    timezone: getEnv("TIMEZONE") ?? "America/Sao_Paulo",
    routerModel: getEnv("GROQ_ROUTER_MODEL") ?? "openai/gpt-oss-20b",
    answerModel: getEnv("GROQ_ANSWER_MODEL") ?? "openai/gpt-oss-120b",
  };
}
