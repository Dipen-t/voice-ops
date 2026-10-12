import { resolve } from 'node:path';
import { asyncBufferFromFile, parquetMetadataAsync, parquetReadObjects } from 'hyparquet';
import { compressors } from 'hyparquet-compressors';
import { loadSelection, loadRepository } from './lib/selection.js';
import { downloadFile, rawDirectory, privateDirectory, saveJson } from './lib/source.js';

async function download() {
  const selection = await loadSelection();
  const info = await loadRepository();
  if (selection.revision !== info.sha) throw new Error('Selection revision differs from repository listing');
  console.log(`Anticipated selected telemetry download: ${selection.totalBytes} bytes (three cases)`);
  const audit: unknown[] = [];
  for (const selected of selection.cases) {
    for (const entry of selected.files) {
      const source = info.siblings.find((file) => file.rfilename === entry.sourcePath);
      if (!source || source.size !== entry.bytes) throw new Error('Source metadata changed');
      const path = resolve(rawDirectory, selected.publicId, `${entry.kind}.parquet`);
      console.log(`${selected.displayTitle}: ${entry.kind}, anticipated ${entry.bytes} bytes`);
      const sha256 = await downloadFile(info, source, path);
      const file = await asyncBufferFromFile(path);
      const metadata = await parquetMetadataAsync(file);
      const rows = await parquetReadObjects({ file, metadata, compressors, rowStart: 0, rowEnd: 3,
        parsers: { timestampFromMilliseconds: (value) => value, timestampFromMicroseconds: (value) => value, timestampFromNanoseconds: (value) => value },
      });
      const report = {
        publicId: selected.publicId, kind: entry.kind, bytes: entry.bytes, sha256,
        rows: metadata.num_rows, rowGroups: metadata.row_groups.map((group) => group.num_rows),
        schema: metadata.schema, codecs: [...new Set(metadata.row_groups.flatMap((group) => group.columns.map((column) => column.meta_data?.codec)))],
        examples: rows,
      };
      audit.push(report);
      await saveJson(resolve(privateDirectory, 'telemetry-audit.json'), audit);
      console.log(`Verified ${entry.kind}: ${metadata.num_rows} rows; ${metadata.schema.length - 1} columns`);
    }
  }
}
download().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'Case download failed');
  process.exitCode = 1;
});
