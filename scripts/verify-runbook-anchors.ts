import { writeFile } from 'node:fs/promises';
import { loadDocument } from '../packages/rag/src/corpus.js';

async function main() {
  const sources=[];
  for(let index=0;index<4;index++) {
    const document=await loadDocument(index);
    const response=await fetch(document.source.url,{signal:AbortSignal.timeout(15000)});
    if(!response.ok||!response.body)throw new Error('SOURCE_UNAVAILABLE');
    let bytes=0;const parts:Uint8Array[]=[];
    for await(const part of response.body){bytes+=part.length;if(bytes>2000000)throw new Error('SOURCE_SIZE_LIMIT');parts.push(part);}
    const html=Buffer.concat(parts).toString();
    const ids=new Set([...html.matchAll(/\bid=(?:"([^"]+)"|'([^']+)'|([^\s>]+))/g)].map(m=>m[1]??m[2]??m[3]));
    const anchors=[...new Set(document.chunks.map(c=>c.anchor).filter(Boolean))];
    const missing=anchors.filter(anchor=>!ids.has(anchor));
    sources.push({url:document.source.url,anchors_checked:anchors.length,missing});
  }
  await writeFile('eval/reports/rag-anchors.json',JSON.stringify({capturedAt:new Date().toISOString(),sources},null,2)+'\n');
  console.log(JSON.stringify(sources));
  if(sources.some(s=>s.missing.length))process.exitCode=1;
}
main().catch(()=>{console.error('Live source anchor verification failed');process.exitCode=1;});
