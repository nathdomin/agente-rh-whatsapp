// Envia o modelo hello_world para abrir a conversa com cada celular de teste.
// Uso: npm run hello -- 5511999999999 5511888888888
import { requireEnv } from "../supabase/functions/_shared/config.ts";
import { alternatePhone } from "../supabase/functions/_shared/phone.ts";

const env = (name: string) => process.env[name];
const token = requireEnv(env, "META_ACCESS_TOKEN");
const phoneNumberId = requireEnv(env, "META_PHONE_NUMBER_ID");
const version = env("META_GRAPH_VERSION") ?? "v23.0";

const phones = process.argv.slice(2);
if (phones.length === 0) {
  console.error("Informe os telefones. Exemplo: npm run hello -- 5511999999999");
  process.exit(1);
}

const NOT_ALLOWED_RECIPIENT = 131030;

async function sendHello(to: string) {
  const response = await fetch(`https://graph.facebook.com/${version}/${phoneNumberId}/messages`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to,
      type: "template",
      template: { name: "hello_world", language: { code: "en_US" } },
    }),
  });
  const body = await response.json();
  console.log(`${to}: ${response.ok ? "enviado" : `erro ${body?.error?.code}: ${body?.error?.message}`}`);
  return response.ok ? null : body?.error?.code;
}

for (const phone of phones) {
  const to = phone.replace(/\D/g, "");
  const alternate = alternatePhone(to);
  if ((await sendHello(to)) === NOT_ALLOWED_RECIPIENT && alternate) {
    console.log(`Tentando a outra forma do número (com/sem o 9º dígito)...`);
    await sendHello(alternate);
  }
}
