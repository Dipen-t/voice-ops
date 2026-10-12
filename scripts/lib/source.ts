import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, open, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { z } from 'zod';

export const repository = 'phamquiluan/RCAEval';
export const rawDirectory = resolve('data/raw');
export const privateDirectory = resolve('data/private-evaluation');
const maximumFileBytes = 100 * 1024 * 1024;

const sourceFileSchema = z.object({
  rfilename: z.string(),
  size: z.number().int().nonnegative(),
  blobId: z.string().regex(/^[a-f0-9]{40}$/).optional(),
  lfs: z.object({ sha256: z.string().regex(/^[a-f0-9]{64}$/), size: z.number() }).optional(),
});
export const repositorySchema = z.object({
  sha: z.string().regex(/^[a-f0-9]{40}$/),
  cardData: z.object({ license: z.string() }),
  siblings: z.array(sourceFileSchema),
});
export type RepositoryInfo = z.infer<typeof repositorySchema>;
export type SourceFile = z.infer<typeof sourceFileSchema>;

export function json(value: unknown) {
  return JSON.stringify(value, (_key, item: unknown) => typeof item === 'bigint' ? item.toString() : item, 2) + '\n';
}

export async function saveJson(path: string, value: unknown) {
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.tmp`;
  await writeFile(temporary, json(value), { mode: 0o600 });
  await rename(temporary, path);
}

export async function loadJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, 'utf8')) as unknown;
}

export async function checksum(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

async function gitBlobChecksum(path: string, bytes: number) {
  const hash = createHash('sha1').update(`blob ${bytes}\0`);
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

export async function getRepositoryInfo(): Promise<RepositoryInfo> {
  const response = await fetch(`https://huggingface.co/api/datasets/${repository}?blobs=true`, {
    signal: AbortSignal.timeout(30000),
  });
  if (!response.ok) throw new Error(`Dataset metadata returned HTTP ${response.status}`);
  return repositorySchema.parse(await response.json());
}

// Only paths verified against the pinned repository listing are downloadable.
// This importer is a local CLI, never an agent tool or public URL-fetch endpoint.
export async function downloadFile(info: RepositoryInfo, file: SourceFile, destination: string): Promise<string> {
  if (!info.siblings.some((entry) => entry.rfilename === file.rfilename && entry.size === file.size)) {
    throw new Error('File is not in the verified repository listing');
  }
  if (file.size > maximumFileBytes) throw new Error('File exceeds the 100 MiB per-file download budget');
  try {
    const existing = await stat(destination);
    const digest = await checksum(destination);
    const valid = file.lfs ? digest === file.lfs.sha256
      : file.blobId ? await gitBlobChecksum(destination, existing.size) === file.blobId : false;
    if (existing.size === file.size && valid) return digest;
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
  }
  const path = file.rfilename.split('/').map(encodeURIComponent).join('/');
  const response = await fetch(`https://huggingface.co/datasets/${repository}/resolve/${info.sha}/${path}`, {
    signal: AbortSignal.timeout(180000),
    redirect: 'follow',
  });
  if (!response.ok || !response.body) throw new Error(`Dataset download returned HTTP ${response.status}`);
  const declared = response.headers.get('content-length');
  if (declared && Number(declared) !== file.size) throw new Error('Download content length differs from listing');
  await mkdir(dirname(destination), { recursive: true });
  const temporary = `${destination}.part`;
  const handle = await open(temporary, 'w', 0o600);
  const hash = createHash('sha256');
  let bytes = 0;
  try {
    for await (const chunk of response.body) {
      bytes += chunk.length;
      if (bytes > file.size || bytes > maximumFileBytes) throw new Error('Download exceeded the declared size');
      hash.update(chunk);
      let written = 0;
      while (written < chunk.length) {
        const result = await handle.write(chunk, written, chunk.length - written);
        if (!result.bytesWritten) throw new Error('Download write made no progress');
        written += result.bytesWritten;
      }
    }
  } finally {
    await handle.close();
  }
  const digest = hash.digest('hex');
  if (bytes !== file.size) throw new Error('Download is incomplete');
  if (file.lfs && digest !== file.lfs.sha256) throw new Error('Download checksum differs from the repository');
  if (!file.lfs && file.blobId && await gitBlobChecksum(temporary, bytes) !== file.blobId) throw new Error('Downloaded Git blob differs from the repository');
  await rename(temporary, destination);
  return digest;
}
