import { asyncBufferFromFile, parquetMetadataAsync, parquetReadObjects } from 'hyparquet';
import { compressors } from 'hyparquet-compressors';
import type { Row } from './normalize.js';

export async function openParquet(path: string) {
  const file = await asyncBufferFromFile(path);
  const metadata = await parquetMetadataAsync(file);
  const count = Number(metadata.num_rows);
  if (!Number.isSafeInteger(count) || count > 2000000) throw new Error('Parquet row count exceeds the importer budget');
  return {
    count, schema: metadata.schema,
    read: async (start: number, end: number): Promise<Row[]> => {
      if (start < 0 || end > count || end < start || end - start > 4096) throw new Error('Invalid Parquet batch bounds');
      return parquetReadObjects({ file, metadata, compressors, rowStart: start, rowEnd: end, useOffsetIndex: true,
        parsers: { timestampFromMilliseconds: (value) => value, timestampFromMicroseconds: (value) => value, timestampFromNanoseconds: (value) => value },
      }) as Promise<Row[]>;
    },
  };
}
