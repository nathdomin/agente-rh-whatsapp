// Carrega os documentos de knowledge/ na base. Substitui os documentos anteriores, sem tocar nas FAQs aprovadas.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { chunkMarkdown } from "../supabase/functions/_shared/chunk.ts";
import { requireEnv } from "../supabase/functions/_shared/config.ts";

const env = (name: string) => process.env[name];
const url = requireEnv(env, "SUPABASE_URL");
const key = requireEnv(env, "SUPABASE_SERVICE_ROLE_KEY");
const headers = { apikey: key, Authorization: `Bearer ${key}`, "Content-Type": "application/json" };

const dir = join(import.meta.dirname, "..", "knowledge");
const rows = readdirSync(dir)
  .filter((file) => file.endsWith(".md"))
  .flatMap((file) => chunkMarkdown(readFileSync(join(dir, file), "utf8")).map((chunk) => ({ source: "documento", ...chunk })));

const removed = await fetch(`${url}/rest/v1/kb_chunks?source=eq.documento`, { method: "DELETE", headers });
if (!removed.ok) throw new Error(`Falha ao limpar: ${await removed.text()}`);

const inserted = await fetch(`${url}/rest/v1/kb_chunks`, { method: "POST", headers, body: JSON.stringify(rows) });
if (!inserted.ok) throw new Error(`Falha ao inserir: ${await inserted.text()}`);

console.log(`${rows.length} trechos carregados.`);
