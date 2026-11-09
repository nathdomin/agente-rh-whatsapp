export interface DocumentChunk {
  title: string;
  section: string;
  content: string;
}

const MAX_CHARS = 1200;

function splitLong(text: string): string[] {
  if (text.length <= MAX_CHARS) return [text];
  const pieces: string[] = [];
  let current = "";
  for (const paragraph of text.split(/\n\s*\n/)) {
    if (current && current.length + paragraph.length + 2 > MAX_CHARS) {
      pieces.push(current);
      current = paragraph;
    } else {
      current = current ? `${current}\n\n${paragraph}` : paragraph;
    }
  }
  if (current) pieces.push(current);
  return pieces;
}

/** Divide um Markdown em trechos por seção (##). O texto antes da primeira seção é ignorado. */
export function chunkMarkdown(markdown: string): DocumentChunk[] {
  const title = markdown.match(/^#\s+(.+)$/m)?.[1]?.trim() ?? "Documento";
  const chunks: DocumentChunk[] = [];
  const sections = markdown.split(/^##\s+/m).slice(1);
  for (const raw of sections) {
    const newline = raw.indexOf("\n");
    const section = (newline === -1 ? raw : raw.slice(0, newline)).trim();
    const body = newline === -1 ? "" : raw.slice(newline + 1).trim();
    if (!body) continue;
    for (const content of splitLong(body)) chunks.push({ title, section, content });
  }
  return chunks;
}
