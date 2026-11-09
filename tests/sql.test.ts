import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { unaccent } from "@electric-sql/pglite/contrib/unaccent";
import { chunkMarkdown } from "../supabase/functions/_shared/chunk.ts";

const root = join(import.meta.dirname, "..");
let db: PGlite;

async function reserve(cap: number, limit: number) {
  const { rows } = await db.query<{ ok: boolean }>(
    "select public.reserve_quota('2026-11', '2026-11-10', $1, $2) as ok",
    [cap, limit],
  );
  return rows[0].ok;
}

async function search(query: string, keywords: string[] = []) {
  const { rows } = await db.query<{ section: string }>(
    "select section from public.search_kb($1, $2, 4)",
    [query, keywords],
  );
  return rows.map((r) => r.section);
}

before(async () => {
  db = new PGlite({ extensions: { unaccent, pg_trgm } });
  await db.exec("create role anon; create role authenticated; create role service_role bypassrls;");
  await db.exec(readFileSync(join(root, "supabase/migrations/20261108000001_init.sql"), "utf8"));

  for (const file of readdirSync(join(root, "knowledge"))) {
    for (const chunk of chunkMarkdown(readFileSync(join(root, "knowledge", file), "utf8"))) {
      await db.query(
        "insert into public.kb_chunks (source, title, section, content) values ('documento', $1, $2, $3)",
        [chunk.title, chunk.section, chunk.content],
      );
    }
  }
});

after(async () => {
  await db.close();
});

describe("cota no banco", () => {
  test("respeita o limite do dia e devolve a reserva", async () => {
    assert.equal(await reserve(10, 2), true);
    assert.equal(await reserve(10, 2), true);
    assert.equal(await reserve(10, 2), false);
    await db.query("select public.release_quota('2026-11', '2026-11-10')");
    assert.equal(await reserve(10, 2), true);
  });

  test("respeita o teto do mês", async () => {
    assert.equal(await reserve(2, 100), false);
  });

  test("reservas simultâneas não ultrapassam o limite", async () => {
    const results = await Promise.all(Array.from({ length: 10 }, () => reserve(50, 8)));
    const { rows } = await db.query<{ used: number }>("select used from public.quota_day where day = '2026-11-10'");
    assert.equal(rows[0].used, 8);
    assert.equal(results.filter(Boolean).length, 6);
  });
});

describe("busca na base", () => {
  test("encontra segunda via do crachá", async () => {
    assert.equal((await search("como peço a segunda via do crachá?"))[0], "Segunda via do crachá");
  });

  test("funciona sem acento e com erro de digitação", async () => {
    assert.ok((await search("segunda via do cracha")).includes("Segunda via do crachá"));
    assert.ok((await search("segunda via do crachaa", ["crachá"])).includes("Segunda via do crachá"));
  });

  test("encontra inclusão de dependentes", async () => {
    const results = await search("Como incluir minha filha no plano de saúde?", ["dependente", "filha", "inclusão"]);
    assert.equal(results[0], "Inclusão de dependentes no plano de saúde");
  });

  test("encontra vale-refeição e pedido de demissão", async () => {
    assert.equal((await search("qual o valor do vale refeição"))[0], "Vale-refeição");
    assert.equal((await search("como pedir demissão"))[0], "Como pedir demissão");
  });

  test("não encontra nada para assunto sem relação", async () => {
    assert.deepEqual(await search("xilofone zumbido"), []);
  });

  test("texto com caracteres especiais não quebra a busca", async () => {
    await search("isso & aquilo | (teste) ' : ! <->");
  });
});

describe("permissões", () => {
  test("usuários públicos não acessam as tabelas", async () => {
    await db.exec("set role anon;");
    await assert.rejects(db.query("select * from public.messages"));
    await db.exec("reset role;");
  });

  test("service_role acessa as tabelas e funções", async () => {
    await db.exec("set role service_role;");
    await db.query("select * from public.messages");
    await db.query("select public.reserve_quota('2026-12', '2026-12-01', 1, 1)");
    await db.exec("reset role;");
  });
});
