// No Brasil, o mesmo celular pode aparecer com e sem o 9º dígito (55 + DDD + 9 + 8 dígitos).

const BR_WITH_NINE = /^55(\d{2})9(\d{8})$/;
const BR_WITHOUT_NINE = /^55(\d{2})(\d{8})$/;

function digits(phone: string): string {
  return phone.replace(/\D/g, "");
}

/** Chave única do telefone, igual com ou sem o 9º dígito. */
export function phoneKey(phone: string): string {
  const clean = digits(phone);
  const match = clean.match(BR_WITH_NINE);
  return match ? `55${match[1]}${match[2]}` : clean;
}

/** Forma alternativa do número (com/sem o 9), usada quando a Meta recusa a primeira. */
export function alternatePhone(phone: string): string | null {
  const clean = digits(phone);
  const withNine = clean.match(BR_WITH_NINE);
  if (withNine) return `55${withNine[1]}${withNine[2]}`;
  const withoutNine = clean.match(BR_WITHOUT_NINE);
  if (withoutNine) return `55${withoutNine[1]}9${withoutNine[2]}`;
  return null;
}

/** Mostra só o final do número nas telas do RH. */
export function maskPhone(phone: string): string {
  const clean = digits(phone);
  return clean.length <= 4 ? clean : `••••${clean.slice(-4)}`;
}
