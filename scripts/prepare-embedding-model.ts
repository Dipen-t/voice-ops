import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { z } from 'zod';

const repository = 'Xenova/all-MiniLM-L6-v2';
const metadataSchema = z.object({ sha: z.string().regex(/^[a-f0-9]{40}$/), siblings: z.array(z.object({ rfilename: z.string(), size: z.number().optional(), blobId: z.string().optional(), lfs: z.object({ size: z.number(), sha256: z.string() }).optional() })) });
const names = ['config.json','tokenizer.json','tokenizer_config.json','special_tokens_map.json','onnx/model_quantized.onnx'];
const digest = (data: Uint8Array) => createHash('sha256').update(data).digest('hex');
async function bounded(url: string, limit: number): Promise<Buffer> {
  const response = await fetch(url,{ signal: AbortSignal.timeout(120000) });
  if (!response.ok || !response.body) throw new Error('MODEL_DOWNLOAD_FAILED');
  const parts: Uint8Array[] = []; let bytes = 0;
  for await (const part of response.body) { bytes += part.length; if (bytes > limit) { await response.body.cancel().catch(() => {}); throw new Error('MODEL_SIZE_LIMIT'); } parts.push(part); }
  return Buffer.concat(parts);
}
try {
  let revision = 'main';
  try { const old = JSON.parse(await readFile('data/embedding-model.json','utf8')); revision = z.string().regex(/^[a-f0-9]{40}$/).parse(old.revision); } catch (error) { if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error; }
  const metadata = metadataSchema.parse(JSON.parse((await bounded(`https://huggingface.co/api/models/${repository}/revision/${revision}?blobs=true`,1048576)).toString()));
  const files: { path: string; bytes: number; sha256: string }[] = [];
  const base = `data/models/${repository}`;
  let total = 0;
  for (const name of names) {
    const listed = metadata.siblings.find(f => f.rfilename === name);
    const size = listed?.lfs?.size ?? listed?.size;
    if (!listed || !size || size > 40000000) throw new Error('MODEL_SOURCE_METADATA_REQUIRED');
    total += size; if (total > 50000000) throw new Error('MODEL_SIZE_LIMIT');
    let data: Buffer;
    try { data = await readFile(`${base}/${name}`); } catch { data = await bounded(`https://huggingface.co/${repository}/resolve/${metadata.sha}/${name}`,size); }
    const sha256 = digest(data);
    const git = createHash('sha1').update(`blob ${data.length}\0`).update(data).digest('hex');
    if (data.length !== size || (listed.lfs ? sha256 !== listed.lfs.sha256 : git !== listed.blobId)) throw new Error('MODEL_CHECKSUM_MISMATCH');
    await mkdir(`${base}/${name.includes('/') ? 'onnx' : ''}`,{ recursive: true });
    await writeFile(`${base}/${name}.part`,data); await rename(`${base}/${name}.part`,`${base}/${name}`);
    files.push({ path: name, bytes: size, sha256 });
  }
  await writeFile('data/embedding-model.json',JSON.stringify({ repository, revision: metadata.sha, dimension:384, dtype:'q8', pooling:'mean', normalize:true, library:'@huggingface/transformers@4.3.1', license:'Apache-2.0', sourceUrl:`https://huggingface.co/${repository}/tree/${metadata.sha}`, files, totalBytes:total },null,2)+'\n');
  console.log(`Verified local embedding model: ${total} bytes; revision ${metadata.sha}`);
} catch { console.error('Local embedding model preparation failed; no credentials are printed'); process.exitCode=1; }
