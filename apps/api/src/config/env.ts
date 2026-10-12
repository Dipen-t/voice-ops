import { z } from 'zod';

const connectionUrl = (protocols: string[]) => z.string().url().refine(
  (value) => {
    try {
      return protocols.includes(new URL(value).protocol);
    } catch {
      return false;
    }
  },
  'Invalid connection protocol',
);

const schema = z.object({
  DATABASE_URL: connectionUrl(['postgres:', 'postgresql:']),
  REDIS_URL: connectionUrl(['redis:', 'rediss:']),
  HOST: z.string().min(1).default('127.0.0.1'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3001),
  HEALTH_TIMEOUT_MS: z.coerce.number().int().min(100).max(10000).default(1500),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  INVESTIGATOR_ENABLED:z.enum(['true','false']).default('false').transform(v=>v==='true'),
  ASSISTANT_MODE:z.enum(['investigator','documents']).default('investigator'),
  API_BEARER_TOKEN:z.string().min(32).max(128).optional(),
  GROQ_API_KEY:z.string().max(256).default(''),
  GROQ_MODEL:z.string().min(1).max(100).default('openai/gpt-oss-20b'),
  MODEL_REQUESTS_ENABLED:z.enum(['true','false']).default('false').transform(v=>v==='true'),
  SARVAM_API_KEY:z.string().max(256).default(''),
  VOICE_REQUESTS_ENABLED:z.enum(['true','false']).default('false').transform(v=>v==='true'),
});

export type Config = z.infer<typeof schema>;

export function loadConfig(environment: NodeJS.ProcessEnv = process.env): Config {
  const result = schema.safeParse(environment);
  if (!result.success) {
    // Report field names only: invalid connection strings may contain secrets.
    const fields = [...new Set(result.error.issues.map((issue) => issue.path.join('.')))];
    throw new Error(`Invalid environment configuration: ${fields.join(', ')}`);
  }
  return result.data;
}
