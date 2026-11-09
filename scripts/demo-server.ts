// Servidor local da tela de demonstração. Mantém o segredo fora do navegador.
// Uso: npm run demo
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { requireEnv } from "../supabase/functions/_shared/config.ts";

const env = (name: string) => process.env[name];
const endpoint = `${requireEnv(env, "SUPABASE_URL")}/functions/v1/demo-chat`;
const secret = requireEnv(env, "SHEETS_SECRET");
const port = Number(env("DEMO_PORT") ?? 3000);
const pagePath = join(import.meta.dirname, "..", "demo", "index.html");

createServer(async (request, response) => {
  if (request.method === "GET" && (request.url === "/" || request.url === "/index.html")) {
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    response.end(readFileSync(pagePath));
    return;
  }

  if (request.method === "POST" && request.url === "/api") {
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(chunk as Buffer);
      const upstream = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-demo-secret": secret },
        body: Buffer.concat(chunks),
      });
      response.writeHead(upstream.status, { "Content-Type": "application/json" });
      response.end(await upstream.text());
    } catch {
      response.writeHead(502, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ error: "Não foi possível falar com o servidor. Verifique a internet." }));
    }
    return;
  }

  response.writeHead(404);
  response.end();
}).listen(port, "127.0.0.1", () => {
  console.log(`Demonstração em http://localhost:${port}`);
});
