import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { describe, test } from "node:test";
import { alternatePhone, maskPhone, phoneKey } from "../supabase/functions/_shared/phone.ts";
import { maskPersonalData } from "../supabase/functions/_shared/privacy.ts";
import { businessDaysLeft, dailyLimit, localDate } from "../supabase/functions/_shared/quota.ts";
import { isFormerEmployee, isGreeting, isSensitive } from "../supabase/functions/_shared/router.ts";
import { chunkMarkdown } from "../supabase/functions/_shared/chunk.ts";
import { parseJsonObject } from "../supabase/functions/_shared/llm.ts";
import { parseWebhook, verifySignature } from "../supabase/functions/_shared/webhook.ts";
import { createWhatsAppClient } from "../supabase/functions/_shared/whatsapp.ts";

describe("telefone", () => {
  test("com e sem o 9º dígito geram a mesma chave", () => {
    assert.equal(phoneKey("+55 (11) 98765-4321"), phoneKey("551187654321"));
  });
  test("alterna entre as duas formas", () => {
    assert.equal(alternatePhone("5511987654321"), "551187654321");
    assert.equal(alternatePhone("551187654321"), "5511987654321");
    assert.equal(alternatePhone("14155552671"), null);
  });
  test("mascara o número", () => assert.equal(maskPhone("5511987654321"), "••••4321"));
});

describe("privacidade", () => {
  test("mascara CPF e e-mail", () => {
    assert.equal(maskPersonalData("cpf 123.456.789-00 mail ana@x.com"), "cpf [CPF] mail [EMAIL]");
  });
  test("mascara sequência numérica longa e preserva valores curtos", () => {
    assert.equal(maskPersonalData("matricula 1234567 em 30 dias"), "matricula [NUMERO] em 30 dias");
  });
});

describe("cota", () => {
  test("usa o fuso de São Paulo na virada do mês", () => {
    const date = localDate(new Date("2026-12-01T02:00:00Z"), "America/Sao_Paulo");
    assert.equal(date.monthKey, "2026-11");
    assert.equal(date.dayKey, "2026-11-30");
  });
  test("conta dias úteis restantes", () => {
    assert.equal(businessDaysLeft(2026, 11, 30), 1);
    assert.equal(businessDaysLeft(2026, 11, 2), 21);
  });
  test("fim de semana conta como pelo menos um dia", () => {
    assert.equal(businessDaysLeft(2026, 11, 28), 2);
  });
  test("divide o saldo pelos dias restantes", () => {
    assert.equal(dailyLimit({ monthlyCap: 950, usedMonth: 0, usedToday: 0, daysLeft: 22, priority: true }), 44);
  });
  test("o uso de hoje não reduz a cota de hoje", () => {
    assert.equal(dailyLimit({ monthlyCap: 950, usedMonth: 30, usedToday: 30, daysLeft: 22, priority: true }), 44);
  });
  test("conversas novas ficam com 80% da cota do dia", () => {
    assert.equal(dailyLimit({ monthlyCap: 950, usedMonth: 0, usedToday: 0, daysLeft: 22, priority: false }), 36);
  });
  test("saldo zerado resulta em limite zero", () => {
    assert.equal(dailyLimit({ monthlyCap: 950, usedMonth: 950, usedToday: 0, daysLeft: 5, priority: true }), 0);
  });
});

describe("regras rápidas", () => {
  test("detecta temas sensíveis, com e sem acento", () => {
    for (const t of ["Sofri assédio do gestor", "estou gravida", "quero enviar meu atestado"]) {
      assert.ok(isSensitive(t), t);
    }
    assert.ok(!isSensitive("como peço a segunda via do crachá?"));
  });
  test("detecta ex-funcionário", () => {
    for (const t of ["Fui desligado semana passada", "me mandaram embora ontem", "sou ex-funcionária"]) {
      assert.ok(isFormerEmployee(t), t);
    }
  });
  test("não confunde pedido de demissão com desligado", () => {
    for (const t of ["como peço demissão?", "o que acontece se eu for demitido?", "quero pedir demissão"]) {
      assert.ok(!isFormerEmployee(t), t);
    }
  });
  test("saudação só quando não há pergunta", () => {
    assert.ok(isGreeting("Bom dia!"));
    assert.ok(!isGreeting("bom dia, como peço férias?"));
  });
});

describe("documentos", () => {
  test("divide por seção e ignora o aviso inicial", () => {
    const chunks = chunkMarkdown("# Titulo\n\n> aviso\n\n## A\n\ntexto a\n\n## B\n\ntexto b\n");
    assert.deepEqual(chunks, [
      { title: "Titulo", section: "A", content: "texto a" },
      { title: "Titulo", section: "B", content: "texto b" },
    ]);
  });
  test("divide seções muito longas", () => {
    const paragraph = "x".repeat(800);
    const chunks = chunkMarkdown(`# T\n\n## A\n\n${paragraph}\n\n${paragraph}\n`);
    assert.equal(chunks.length, 2);
  });
});

describe("JSON do modelo", () => {
  test("aceita texto em volta", () => assert.deepEqual(parseJsonObject('ok {"a":1} fim'), { a: 1 }));
  test("recusa texto sem JSON", () => assert.throws(() => parseJsonObject("nada")));
});

describe("webhook", () => {
  const body = '{"a":1}';
  const valid = "sha256=" + createHmac("sha256", "segredo").update(body).digest("hex");

  test("aceita assinatura correta", async () => assert.equal(await verifySignature("segredo", body, valid), true));
  test("recusa assinatura errada", async () => {
    assert.equal(await verifySignature("outro", body, valid), false);
    assert.equal(await verifySignature("segredo", body, null), false);
    assert.equal(await verifySignature("segredo", body, "sha256=abc"), false);
  });

  test("guarda o motivo de uma falha de entrega", () => {
    const parsed = parseWebhook({
      entry: [{
        changes: [{
          value: {
            statuses: [{
              id: "s",
              status: "failed",
              errors: [{ code: 130497, title: "Restrito", error_data: { details: "País bloqueado" } }],
            }],
          },
        }],
      }],
    });
    assert.deepEqual(parsed.statuses[0].error, { code: 130497, title: "Restrito", details: "País bloqueado" });
  });

  test("interpreta texto, áudio, reação e status", () => {
    const parsed = parseWebhook({
      entry: [{
        changes: [{
          value: {
            messages: [
              { id: "a", from: "55", type: "text", text: { body: "oi" } },
              { id: "b", from: "55", type: "audio", audio: { id: "media1" } },
              { id: "c", from: "55", type: "reaction", reaction: { message_id: "x", emoji: "👍" } },
            ],
            statuses: [{ id: "s", status: "delivered" }],
          },
        }],
      }],
    });
    assert.equal(parsed.messages[0].text, "oi");
    assert.equal(parsed.messages[1].mediaId, "media1");
    assert.deepEqual(parsed.reactions, [{ targetWaMessageId: "x", emoji: "👍" }]);
    assert.deepEqual(parsed.statuses, [{ waMessageId: "s", status: "delivered" }]);
  });
});

describe("envio pelo WhatsApp", () => {
  test("tenta a outra forma do número quando a Meta recusa o destinatário", async () => {
    const recipients: string[] = [];
    const fetchFn = (async (_url: string, init: RequestInit) => {
      const to = JSON.parse(init.body as string).to;
      recipients.push(to);
      if (to === "551187654321") {
        return new Response(JSON.stringify({ error: { message: "not allowed", code: 131030 } }), { status: 400 });
      }
      return new Response(JSON.stringify({ messages: [{ id: "wamid.1" }] }), { status: 200 });
    }) as typeof fetch;
    const client = createWhatsAppClient({ token: "t", phoneNumberId: "1", graphVersion: "v23.0", fetchFn });
    assert.equal(await client.sendText("551187654321", "oi"), "wamid.1");
    assert.deepEqual(recipients, ["551187654321", "5511987654321"]);
  });
});
