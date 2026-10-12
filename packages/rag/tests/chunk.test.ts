import { expect,it } from 'vitest';
import { anchorFor,chunkMarkdown,hash } from '../src/chunk.js';
import { searchInput,fuse } from '../src/search.js';

it('synthetic section chunking preserves source lines, explicit anchors and deterministic IDs',()=>{
  const markdown='---\ntitle: ignored\n---\n## Allowed {#real-anchor}\nUseful text here.\n```sh\nignored command\n```\n### Nested\nNested content.\n## Excluded\nPrivate material.';
  const chunks=chunkMarkdown(markdown,'document','Title',['real-anchor']);
  expect(chunks).toHaveLength(2);expect(chunks[0]).toEqual(expect.objectContaining({anchor:'real-anchor',content:'Useful text here.',source_start_line:5,source_end_line:5}));
  expect(chunks[1]?.heading).toBe('Allowed > Nested');
  expect(JSON.stringify(chunks)).not.toMatch(/ignored command|Private material/);
  expect(chunkMarkdown(markdown,'document','Title',['real-anchor'])).toEqual(chunks);
  expect(chunks[0]?.content_sha256).toBe(hash('Useful text here.'));
});
it('synthetic overlap is bounded and splitting never crosses source sections',()=>{
  const chunks=chunkMarkdown('## One\n'+Array.from({length:150},(_,i)=>`word${i}`).join(' ')+'\n## Two\nother words','doc','Title',['one','two'],40,5);
  expect(chunks.every(c=>c.content.split(' ').length<=40)).toBe(true);
  expect(chunks[1]?.content.split(' ').slice(0,5)).toEqual(chunks[0]?.content.split(' ').slice(-5));
  expect(()=>chunkMarkdown('','doc','Title',[],40,40)).toThrow('INVALID_SPLITTER_BOUNDS');
  expect(anchorFor('Using `kubectl describe pod` to fetch details about pods')).toBe('using-kubectl-describe-pod-to-fetch-details-about-pods');
});
it('synthetic retrieval inputs are bounded and fusion deduplicates matching chunks',()=>{
  expect(searchInput.safeParse({query:'x'.repeat(513)}).success).toBe(false);
  expect(searchInput.safeParse({query:'valid query',limit:9}).success).toBe(false);
  expect(searchInput.safeParse({query:'valid query',sql:'SELECT 1'}).success).toBe(false);
  type Row=Parameters<typeof fuse>[0][number];
  const a={id:'a'} as Row,b={id:'b'} as Row;
  expect(fuse([a,b],[b]).map(r=>r.id)).toEqual(['b','a']);
});
