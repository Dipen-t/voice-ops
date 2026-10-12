import { readFile, stat } from 'node:fs/promises';
import { z } from 'zod';
import { hash, chunkMarkdown } from './chunk.js';

const sourceSchema = z.object({ title: z.string(), url: z.url(), repositoryRevision: z.string().regex(/^[a-f0-9]{40}$/), sha256: z.string().regex(/^[a-f0-9]{64}$/), license: z.literal('CC-BY-4.0'), attribution: z.string(), bytes: z.number().max(100000) });
export const sections: readonly (readonly string[])[] = [
  ['using-kubectl-describe-pod-to-fetch-details-about-pods','example-debugging-pending-pods','examine-pod-logs'],
  ['', 'metrics-api','measuring-resource-usage','metrics-server'],
  ['does-the-service-exist','any-network-policy-ingress-rules-affecting-the-target-pods','does-the-service-work-by-dns-name','does-the-service-work-by-ip','is-the-service-defined-correctly','does-the-service-have-any-endpointslices','are-the-pods-working'],
  ['context-propagation','spans'],
];
const urls = [
  'https://kubernetes.io/docs/tasks/debug/debug-application/debug-running-pod/',
  'https://kubernetes.io/docs/tasks/debug/debug-cluster/resource-metrics-pipeline/',
  'https://kubernetes.io/docs/tasks/debug/debug-application/debug-service/',
  'https://opentelemetry.io/docs/concepts/signals/traces/',
];
export async function loadDocument(index: number) {
  if (!Number.isInteger(index) || index < 0 || index >= urls.length) throw new Error('SOURCE_NOT_ALLOWED');
  const manifest = JSON.parse(await readFile('data/runbook-sources.json','utf8')) as { sources: unknown[] };
  const source = sourceSchema.parse(manifest.sources[index]);
  if (source.url !== urls[index]) throw new Error('SOURCE_NOT_ALLOWED');
  const path = `data/raw/runbook-audit/${index + 1}.md`;
  if ((await stat(path)).size !== source.bytes) throw new Error('SOURCE_SIZE_MISMATCH');
  const markdown = await readFile(path, 'utf8');
  if (hash(markdown) !== source.sha256) throw new Error('SOURCE_CHECKSUM_MISMATCH');
  const id = hash(source.url);
  const chunks = chunkMarkdown(markdown, id, source.title, sections[index]!);
  if (!chunks.length) throw new Error('EMPTY_DOCUMENT');
  return { id, source, chunks };
}
