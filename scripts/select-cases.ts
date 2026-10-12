import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { z } from 'zod';
import { caseSchema, loadRepository, selectionSchema, selectionPath } from './lib/selection.js';
import { loadJson, privateDirectory, saveJson } from './lib/source.js';

async function select() {
  const info = await loadRepository();
  try {
    const existing = selectionSchema.parse(await loadJson(selectionPath));
    if (existing.revision !== info.sha) throw new Error('Existing selection belongs to a different revision; explicit reselection is required');
    console.log(`Existing three-case selection retained: ${existing.totalBytes} bytes`);
    return;
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
  }
  const audit = z.object({ sha256: z.string(), candidates: z.array(caseSchema) }).parse(await loadJson(resolve(privateDirectory, 'index-audit.json')));
  const candidates = audit.candidates.map((source) => {
    const files = (['metrics', 'logs', 'traces'] as const).map((kind) => {
      const sourcePath = `${source.case}/${kind}.parquet`;
      const entry = info.siblings.find((file) => file.rfilename === sourcePath);
      if (!entry) throw new Error('An indexed telemetry file is absent from the repository listing');
      return { kind, sourcePath, bytes: entry.size, expectedSha256: entry.lfs?.sha256 ?? null };
    });
    return { source, files, bytes: files.reduce((sum, file) => sum + file.bytes, 0) };
  }).filter((entry) => entry.source.n_logs >= 10 && entry.source.n_traces >= 100 && entry.source.n_timesteps >= 60)
    .sort((left, right) => left.bytes - right.bytes);

  const chosen: typeof candidates = [];
  // These labels are used only in the private selection/evaluation CLI.
  // Choose resource and network categories; prefer distinct affected services.
  for (const category of ['cpu', 'mem', 'delay']) {
    const candidate = candidates.find((entry) => entry.source.fault === category && !chosen.some((selected) => selected.source.root_cause_service === entry.source.root_cause_service))
      ?? candidates.find((entry) => entry.source.fault === category);
    if (!candidate) throw new Error('Required diverse categories are unavailable; selection needs review');
    chosen.push(candidate);
  }
  const totalBytes = chosen.reduce((sum, entry) => sum + entry.bytes, 0);
  if (totalBytes > 100 * 1024 * 1024) throw new Error('Selected cases exceed the conservative 100 MiB initial download budget');
  const selection = selectionSchema.parse({
    revision: info.sha, indexSha256: audit.sha256, totalBytes,
    cases: chosen.map((entry, index) => ({ publicId: randomUUID(), displayTitle: `Recorded incident ${index + 1}`, source: entry.source, files: entry.files })),
  });
  await saveJson(selectionPath, selection);
  console.log(JSON.stringify({ eligible: candidates.length, totalBytes, cases: selection.cases.map((entry) => ({ id: entry.publicId, title: entry.displayTitle, bytes: entry.files.reduce((sum, file) => sum + file.bytes, 0), logs: entry.source.n_logs, traces: entry.source.n_traces, metrics: entry.source.n_timesteps })) }));
}
select().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'Case selection failed');
  process.exitCode = 1;
});
