import { Redis } from 'ioredis';
import { createPool } from '../../../packages/db/src/pool.js';
import type { Config } from './config/env.js';

export interface HealthDependencies {
  postgres: () => Promise<void>;
  redis: () => Promise<void>;
  close: () => Promise<void>;
}

export function createHealthDependencies(config: Config): HealthDependencies {
  const pool = createPool(config.DATABASE_URL, config.HEALTH_TIMEOUT_MS);
  // Idle-client errors should not crash the process or print connection details.
  pool.on('error', () => {});
  return {
    postgres: async () => {
      await pool.query('SELECT 1');
    },
    redis: async () => {
      const redis = new Redis(config.REDIS_URL, {
        lazyConnect: true,
        connectTimeout: config.HEALTH_TIMEOUT_MS,
        commandTimeout: config.HEALTH_TIMEOUT_MS,
        maxRetriesPerRequest: 0,
        retryStrategy: () => null,
      });
      redis.on('error', () => {});
      try {
        await redis.connect();
        if (await redis.ping() !== 'PONG') throw new Error('Redis ping failed');
      } finally {
        redis.disconnect();
      }
    },
    close: () => pool.end(),
  };
}

export async function probe(check: () => Promise<void>, timeoutMs: number): Promise<'up' | 'down'> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      Promise.resolve().then(check),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Health check timed out')), timeoutMs);
      }),
    ]);
    return 'up';
  } catch {
    return 'down';
  } finally {
    clearTimeout(timer);
  }
}
