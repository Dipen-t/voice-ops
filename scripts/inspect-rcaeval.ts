import { resolve } from 'node:path';
import { asyncBufferFromFile, parquetMetadataAsync, parquetReadObjects } from 'hyparquet';
import { compressors } from 'hyparquet-compressors';
import { getRepositoryInfo, downloadFile, saveJson, privateDirectory, rawDirectory } from './lib/source.js';

async function inspect() {
  const info = await getRepositoryInfo();
  await saveJson(resolve(privateDirectory, 'repository.json'), info);
  const index = info.siblings.find((file) => file.rfilename === 'cases.parquet');
  if (!index) throw new Error('Index is absent from the actual repository listing');
  console.log(`Pinned revision ${info.sha}; index download ${index.size} bytes; declared license ${info.cardData.license}`);
  const path = resolve(rawDirectory, 'cases.parquet');
  const sha256 = await downloadFile(info, index, path);
  const file = await asyncBufferFromFile(path);
  const metadata = await parquetMetadataAsync(file);
  const rows = await parquetReadObjects({ file, metadata, compressors });
  const candidates = rows.filter((row) => row.dataset === 'RE2-OB' && row.has_logs === true && row.has_traces === true);
  await saveJson(resolve(privateDirectory, 'index-audit.json'), {
    revision: info.sha, sha256, rows: rows.length,
    schema: metadata.schema, codecs: [...new Set(metadata.row_groups.flatMap((group) => group.columns.map((column) => column.meta_data?.codec)))],
    candidates,
  });
  console.log(JSON.stringify({ rows: rows.length, eligibleCases: candidates.length, columns: metadata.schema.slice(1).map((column) => column.name) }));
}

inspect().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'Dataset inspection failed');
  process.exitCode = 1;
});
