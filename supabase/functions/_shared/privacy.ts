const EMAIL = /[\w.+-]+@[\w-]+\.[\w.-]+/g;
const CPF = /\b\d{3}[.\s]?\d{3}[.\s]?\d{3}[-.\s]?\d{2}\b/g;
const LONG_NUMBER = /\b\d{7,}\b/g;

/** Remove dados pessoais antes de guardar a mensagem ou enviá-la ao modelo. */
export function maskPersonalData(text: string): string {
  return text
    .replace(EMAIL, "[EMAIL]")
    .replace(CPF, "[CPF]")
    .replace(LONG_NUMBER, "[NUMERO]");
}
