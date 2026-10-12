import { resolve } from 'node:path';
import { z } from 'zod';
import { privateDirectory, loadJson, repositorySchema } from './source.js';

export const caseSchema = z.object({
  case: z.string(), dataset: z.literal('RE2-OB'), system: z.string(),
  root_cause_service: z.string(), fault: z.string(),
  inject_time: z.coerce.string(),
  n_timesteps: z.coerce.number().int().positive(),
  n_metrics: z.coerce.number().int().positive(),
  n_logs: z.coerce.number().int().nonnegative(),
  n_traces: z.coerce.number().int().nonnegative(),
  time_start: z.coerce.string(), time_end: z.coerce.string(),
});
export const selectionSchema = z.object({
  revision: z.string(), indexSha256: z.string(), totalBytes: z.number(),
  cases: z.array(z.object({
    publicId: z.string().uuid(), displayTitle: z.string(),
    source: caseSchema,
    files: z.array(z.object({ kind: z.enum(['metrics', 'logs', 'traces']), sourcePath: z.string(), bytes: z.number(), expectedSha256: z.string().nullable() })),
  })).length(3),
});
export type Selection = z.infer<typeof selectionSchema>;
export type SelectedCase = Selection['cases'][number];
export const selectionPath = resolve(privateDirectory, 'selection.json');

export async function loadSelection() {
  return selectionSchema.parse(await loadJson(selectionPath));
}
export async function loadRepository() {
  return repositorySchema.parse(await loadJson(resolve(privateDirectory, 'repository.json')));
}
