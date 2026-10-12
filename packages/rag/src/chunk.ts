import { createHash } from 'node:crypto';

export const splitterVersion = 'sections-v1-100words-overlap20';
export type Chunk = { id: string; ordinal: number; heading: string; anchor: string; content: string; content_sha256: string; source_start_line: number; source_end_line: number };
export const hash = (value: string) => createHash('sha256').update(value).digest('hex');
export function anchorFor(heading: string) {
  const explicit = heading.match(/\{#([\w-]+)\}/)?.[1];
  return explicit ?? heading.replace(/[`*_]/g,'').toLowerCase().replace(/[^\p{L}\p{N}\s-]/gu,'').trim().replace(/\s+/g,'-');
}
export function chunkMarkdown(markdown: string, documentId: string, title: string, allowed: readonly string[], targetWords = 100, overlapWords = 20): Chunk[] {
  if (targetWords < 40 || targetWords > 200 || overlapWords < 0 || overlapWords >= targetWords) throw new Error('INVALID_SPLITTER_BOUNDS');
  const chunks: Chunk[] = [];
  let heading = title, anchor = '', sectionRoot = '', fence = false, frontMatter = false, diagram = false;
  let words: { text: string; line: number }[] = [];
  const emit = () => {
    if (!allowed.includes(sectionRoot) || !words.length) { words = []; return; }
    for (let index = 0; index < words.length; index += targetWords - overlapWords) {
      const part = words.slice(index, index + targetWords);
      const content = part.map(w => w.text).join(' ');
      const ordinal = chunks.length;
      chunks.push({ id: hash(`${documentId}:${splitterVersion}:${ordinal}:${anchor}:${content}`), ordinal, heading, anchor, content,
        content_sha256: hash(content), source_start_line: part[0]!.line, source_end_line: part.at(-1)!.line });
      if (index + targetWords >= words.length) break;
    }
    words = [];
  };
  const hierarchy: string[] = [];
  for (const [index, original] of markdown.split(/\r?\n/).entries()) {
    if (index === 0 && original === '---') { frontMatter = true; continue; }
    if (frontMatter) { if (original === '---') frontMatter = false; continue; }
    if (/^\s*(```|~~~)/.test(original)) { fence = !fence; continue; }
    if (fence) continue;
    if (original.includes('{{< mermaid >}}')) { diagram = true; continue; }
    if (original.includes('{{< /mermaid >}}')) { diagram = false; continue; }
    if (diagram) continue;
    const match = original.match(/^(#{1,6})\s+(.+)$/);
    if (match) {
      emit(); const level = match[1]!.length;
      anchor = anchorFor(match[2]!);
      const clean = match[2]!.replace(/\{#[^}]+\}/g,'').replace(/[`*_]/g,'').trim();
      hierarchy.length = level - 1; hierarchy[level - 1] = clean;
      heading = hierarchy.filter(Boolean).join(' > ');
      if (level <= 2) sectionRoot = anchor;
      continue;
    }
    const cleaned = original.replace(/<!--.*?-->/g,'')
      .replace(/\{\{<\s*glossary_tooltip\s+text="([^"]+)"[\s\S]*?>\}\}/g,'$1')
      .replace(/\{\{[<%].*?[>%]\}\}/g,'')
      .replace(/!?\[([^\]]+)\]\([^)]*\)/g,'$1').replace(/[`*_]/g,'').replace(/<[^>]+>/g,'');
    for (const text of cleaned.trim().split(/\s+/).filter(Boolean)) words.push({ text, line: index + 1 });
  }
  emit();
  if (chunks.length > 300 || chunks.some(c => Buffer.byteLength(c.content) > 8192)) throw new Error('CORPUS_LIMIT');
  return chunks;
}
