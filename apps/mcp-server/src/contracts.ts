import { z } from 'zod';

export const epoch = z.string().regex(/^(0|[1-9]\d{0,18})$/).refine(v => BigInt(v) <= 9223372036854775807n, 'Timestamp exceeds int64');
const label = z.string().min(1).max(128).regex(/^[\w.:-]+$/);
export const scope = z.object({ incident_id: z.uuid() }).strict();
export const slice = scope.extend({
  service: label.optional(), start: epoch.optional(), end: epoch.optional(),
  limit: z.number().int().min(1).max(100).default(25),
  cursor: z.string().max(2048).optional(),
}).strict();
export const metrics = slice.extend({ service: label, metric_names: z.array(label).min(1).max(12).optional(), aggregation: z.literal('raw').default('raw') }).strict();
export const logs = slice.extend({ query: z.string().min(1).max(128).optional() }).strict();
export const traces = slice.extend({ trace_id: z.string().min(1).max(256).optional() }).strict();
export type Slice = z.infer<typeof slice> & { metric_names?: string[]; query?: string; trace_id?: string; aggregation?: 'raw' };

export class ToolFailure extends Error {
  constructor(public readonly code: string) { super(code); }
}
export function windowBounds(input: Pick<Slice, 'start' | 'end'>, from: string, to: string) {
  const start = BigInt(input.start ?? from);
  const end = input.end === undefined ? (start + 300000000n < BigInt(to) ? start + 300000000n : BigInt(to)) : BigInt(input.end);
  if (start < BigInt(from) || end > BigInt(to) || end < start || end - start > 900000000n) throw new ToolFailure('INVALID_WINDOW');
  return { start: start.toString(), end: end.toString() };
}
