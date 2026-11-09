export interface LocalDate {
  year: number;
  month: number;
  day: number;
  monthKey: string;
  dayKey: string;
}

export function localDate(now: Date, timezone: string): LocalDate {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const get = (type: string) => parts.find((p) => p.type === type)!.value;
  const [y, m, d] = [get("year"), get("month"), get("day")];
  return {
    year: Number(y),
    month: Number(m),
    day: Number(d),
    monthKey: `${y}-${m}`,
    dayKey: `${y}-${m}-${d}`,
  };
}

/** Dias úteis de hoje até o fim do mês. Hoje sempre conta, mesmo em fim de semana. */
export function businessDaysLeft(year: number, month: number, day: number): number {
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  let count = 1;
  for (let d = day + 1; d <= lastDay; d++) {
    const weekday = new Date(Date.UTC(year, month - 1, d)).getUTCDay();
    if (weekday !== 0 && weekday !== 6) count++;
  }
  return count;
}

export interface DailyLimitInput {
  monthlyCap: number;
  usedMonth: number;
  usedToday: number;
  daysLeft: number;
  priority: boolean;
}

// Conversas novas param em 80% da cota do dia, deixando espaço para as que já começaram.
const NEW_CONVERSATION_SHARE = 0.8;

export function dailyLimit(input: DailyLimitInput): number {
  const remainingAtDayStart = Math.max(0, input.monthlyCap - input.usedMonth + input.usedToday);
  const allowance = Math.ceil(remainingAtDayStart / Math.max(1, input.daysLeft));
  return input.priority ? allowance : Math.ceil(allowance * NEW_CONVERSATION_SHARE);
}
