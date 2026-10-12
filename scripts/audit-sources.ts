import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { z } from 'zod';
import { saveJson, rawDirectory } from './lib/source.js';

async function boundedText(url: string) {
  const response = await fetch(url, { signal: AbortSignal.timeout(30000) });
  if (!response.ok || !response.body) throw new Error(`Source audit returned HTTP ${response.status} for ${url}`);
  let bytes = 0;
  const chunks: Uint8Array[] = [];
  for await (const chunk of response.body) {
    bytes += chunk.length;
    if (bytes > 512 * 1024) throw new Error(`Source audit exceeds 512 KiB for ${url}`);
    chunks.push(chunk);
  }
  const buffer = Buffer.concat(chunks);
  return { content: buffer.toString('utf8'), bytes, sha256: createHash('sha256').update(buffer).digest('hex') };
}

const revisions = new Map<string, string>();
const sourceCache = new Map<string, Awaited<ReturnType<typeof boundedText>> & { sourceUrl: string; revision: string; blobSha: string }>();
async function githubSource(repository: string, path: string) {
  const key = `${repository}/${path}`;
  const existing = sourceCache.get(key);
  if (existing) return existing;
  let revision = revisions.get(repository);
  if (!revision) {
    const result = await boundedText(`https://api.github.com/repos/${repository}/commits/main`);
    revision = z.object({ sha: z.string().regex(/^[a-f0-9]{40}$/) }).parse(JSON.parse(result.content)).sha;
    revisions.set(repository, revision);
  }
  const metadata = await boundedText(`https://api.github.com/repos/${repository}/contents/${path}?ref=${revision}`);
  const file = z.object({ type: z.literal('file'), sha: z.string(), size: z.number(), download_url: z.string().url() }).parse(JSON.parse(metadata.content));
  if (!file.download_url.startsWith(`https://raw.githubusercontent.com/${repository}/${revision}/`)) throw new Error('Unexpected documentation download origin');
  const content = await boundedText(file.download_url);
  const blobSha = createHash('sha1').update(`blob ${content.bytes}\0`).update(content.content, 'utf8').digest('hex');
  if (blobSha !== file.sha || content.bytes !== file.size) throw new Error('Documentation checksum differs from its pinned repository listing');
  const source = { ...content, sourceUrl: file.download_url, revision, blobSha };
  sourceCache.set(key, source);
  return source;
}

async function audit() {
  const license = await githubSource('phamquiluan/RCAEval', 'LICENSE');
  const licenseUrl = license.sourceUrl;
  if (!license.content.includes('MIT License')) throw new Error('Dataset license needs review');
  await mkdir('data/licenses', { recursive: true });
  await writeFile('data/licenses/RCAEval-MIT.txt', license.content);
  const sources = [
    { title: 'Debug running Pods', url: 'https://kubernetes.io/docs/tasks/debug/debug-application/debug-running-pod/', repository: 'kubernetes/website', path: 'content/en/docs/tasks/debug/debug-application/debug-running-pod.md', attribution: 'The Kubernetes Authors', scope: 'Selected sections on inspecting Pod state and resource use; exclude third-party material.' },
    { title: 'Resource metrics pipeline', url: 'https://kubernetes.io/docs/tasks/debug/debug-cluster/resource-metrics-pipeline/', repository: 'kubernetes/website', path: 'content/en/docs/tasks/debug/debug-cluster/resource-metrics-pipeline.md', attribution: 'The Kubernetes Authors', scope: 'Selected resource metrics concepts and limitations; exclude third-party material.' },
    { title: 'Debug Services', url: 'https://kubernetes.io/docs/tasks/debug/debug-application/debug-service/', repository: 'kubernetes/website', path: 'content/en/docs/tasks/debug/debug-application/debug-service.md', attribution: 'The Kubernetes Authors', scope: 'Selected network diagnosis and service connectivity sections; exclude third-party material.' },
    { title: 'Traces', url: 'https://opentelemetry.io/docs/concepts/signals/traces/', repository: 'open-telemetry/opentelemetry.io', path: 'content/en/docs/concepts/signals/traces.md', attribution: 'OpenTelemetry Authors', scope: 'Selected span, trace context and status concepts; exclude third-party material.' },
  ];
  const manifest: unknown[] = [];
  const directory = resolve(rawDirectory, 'runbook-audit');
  await mkdir(directory, { recursive: true });
  for (let index = 0; index < sources.length; index++) {
    const source = sources[index];
    if (!source) throw new Error('Missing approved audit source');
    const license = await githubSource(source.repository, 'LICENSE');
    if (!license.content.includes('Attribution 4.0 International')) throw new Error('Runbook license needs review');
    const page = await githubSource(source.repository, source.path);
    await writeFile(resolve(directory, `${index + 1}.md`), page.content);
    manifest.push({ ...source, sourceUrl: page.sourceUrl, repositoryRevision: page.revision, sourceBlobSha: page.blobSha, licenseUrl: license.sourceUrl,
      capturedAt: new Date().toISOString(), sha256: page.sha256, bytes: page.bytes, license: 'CC-BY-4.0', licenseChecksum: license.sha256,
      approvedImportScope: source.scope, status: 'audited candidate; not chunked, embedded or indexed', modifications: 'None in audit snapshot; later excerpts must identify trimming/formatting changes.' });
  }
  await saveJson('data/runbook-sources.json', { datasetLicense: { url: licenseUrl, sha256: license.sha256, capturedAt: new Date().toISOString(), license: 'MIT' }, sources: manifest,
    coverageGap: 'General troubleshooting guidance does not supply a case-specific diagnosis. No root-cause labels or source case names belong in the RAG corpus.' });
  console.log('Dataset attribution saved and four small CC-BY-4.0 runbook candidates audited. No RAG ingestion claimed.');
}
audit().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'Source/license audit failed; no unverified source is approved for ingestion.');
  process.exitCode = 1;
});
