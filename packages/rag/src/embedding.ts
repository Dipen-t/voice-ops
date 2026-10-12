import { Worker } from 'node:worker_threads';
import { resolve } from 'node:path';
import { readFile, stat } from 'node:fs/promises';
import { z } from 'zod';

const modelSchema = z.object({ repository:z.literal('Xenova/all-MiniLM-L6-v2'), revision:z.string().regex(/^[a-f0-9]{40}$/), dimension:z.literal(384), dtype:z.literal('q8'), pooling:z.literal('mean'), normalize:z.literal(true), library:z.literal('@huggingface/transformers@4.3.1'), files:z.array(z.object({path:z.string(),bytes:z.number().max(40000000),sha256:z.string().regex(/^[a-f0-9]{64}$/)})).length(5) });
export async function modelIdentity() {
  const model = modelSchema.parse(JSON.parse(await readFile('data/embedding-model.json','utf8')));
  const allowed = ['config.json','tokenizer.json','tokenizer_config.json','special_tokens_map.json','onnx/model_quantized.onnx'];
  for (const file of model.files) {
    if (!allowed.includes(file.path)) throw new Error('MODEL_FILE_NOT_ALLOWED');
    const path = `data/models/${model.repository}/${file.path}`;
    if ((await stat(path)).size !== file.bytes) throw new Error('MODEL_CHECKSUM_MISMATCH');
    const bytes = await readFile(path);
    // Hash binary bytes directly (the manifest records SHA-256, not a text encoding).
    const { createHash } = await import('node:crypto');
    if (createHash('sha256').update(bytes).digest('hex') !== file.sha256) throw new Error('MODEL_CHECKSUM_MISMATCH');
  }
  return `${model.repository}@${model.revision}:q8:mean:normalized:384:transformers4.3.1:max256`;
}
export interface EmbeddingProvider { key: string; embed(texts:string[],signal?:AbortSignal):Promise<number[][]>; close():Promise<void> }
export class LocalEmbeddings implements EmbeddingProvider {
  private worker: Worker | undefined;
  private busy = false;
  constructor(public readonly key: string) {}
  async embed(texts:string[], signal?:AbortSignal):Promise<number[][]> {
    if (this.busy) throw new Error('EMBEDDING_BUSY');
    if (!texts.length || texts.length > 8 || texts.some(t => !t.trim() || t.length > 4096)) throw new Error('EMBEDDING_INPUT_LIMIT');
    this.busy = true;
    const worker = this.worker ??= new Worker(resolve('dist/packages/rag/src/embedding-thread.js'));
    try {
      return await new Promise<number[][]>((resolve, reject) => {
        let finished = false;
        const clear = () => { clearTimeout(timer); worker.off('message',message); worker.off('error',error); worker.off('exit',exit); signal?.removeEventListener('abort',abort); };
        const error = () => { if(finished)return; finished=true; clear(); this.worker=undefined; void worker.terminate(); reject(new Error('EMBEDDING_FAILED')); };
        const abort = () => error(); const exit = () => error();
        const message = (value: unknown) => {
          if(finished)return;
          const parsed = z.object({vectors:z.array(z.array(z.number().finite()).length(384)).length(texts.length)}).safeParse(value);
          if (!parsed.success || parsed.data.vectors.some(v => Math.abs(Math.sqrt(v.reduce((s,n)=>s+n*n,0))-1)>0.01)) { error(); return; }
          finished=true; clear(); resolve(parsed.data.vectors);
        };
        const timer = setTimeout(error,60000);
        worker.on('message',message); worker.once('error',error); worker.once('exit',exit);
        signal?.addEventListener('abort',abort,{once:true});
        if(signal?.aborted) {error();return;}
        worker.postMessage(texts);
      });
    } finally { this.busy=false; }
  }
  async close() { const worker=this.worker; this.worker=undefined; if(worker)await worker.terminate(); }
}
