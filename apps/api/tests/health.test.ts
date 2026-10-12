import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config/env.js';
import { probe } from '../src/health.js';
import type { HealthDependencies } from '../src/health.js';

const config = loadConfig({
  DATABASE_URL: 'postgresql://fixture:fixture@localhost/fixture',
  REDIS_URL: 'redis://localhost:6379',
  LOG_LEVEL: 'silent',
});
const apps: ReturnType<typeof buildApp>[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  vi.useRealTimers();
});

function setup(overrides: Partial<HealthDependencies> = {}) {
  // Synthetic dependency doubles; no benchmark telemetry or real-service claim.
  const dependencies: HealthDependencies = {
    postgres: vi.fn(async () => {}),
    redis: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
    ...overrides,
  };
  const app = buildApp(config, dependencies);
  apps.push(app);
  return { app, dependencies };
}

describe('health routes', () => {
  it('liveness works without checking external services', async () => {
    const { app, dependencies } = setup();
    const response = await app.inject('/health/live');
    expect(response.statusCode).toBe(200);
    expect(dependencies.postgres).not.toHaveBeenCalled();
    expect(dependencies.redis).not.toHaveBeenCalled();
  });

  it('readiness requires both dependencies', async () => {
    const { app, dependencies } = setup();
    const response = await app.inject('/health/ready');
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ready', dependencies: { postgres: 'up', redis: 'up' } });
    expect(dependencies.postgres).toHaveBeenCalledOnce();
    expect(dependencies.redis).toHaveBeenCalledOnce();
  });

  it.each(['postgres', 'redis'] as const)('returns 503 when %s fails and hides error details', async (service) => {
    const { app } = setup({ [service]: async () => { throw new Error('password=PRIVATE'); } });
    const response = await app.inject('/health/ready');
    expect(response.statusCode).toBe(503);
    expect(response.json().dependencies[service]).toBe('down');
    expect(response.body).not.toContain('PRIVATE');
  });

  it('closes dependency resources', async () => {
    const { app, dependencies } = setup();
    await app.ready();
    await app.close();
    expect(dependencies.close).toHaveBeenCalledOnce();
  });

  it('bounds stalled checks', async () => {
    vi.useFakeTimers();
    const result = probe(() => new Promise(() => {}), 100);
    await vi.advanceTimersByTimeAsync(100);
    expect(await result).toBe('down');
  });
});

describe('environment validation', () => {
  it('handles malformed URLs without exposing their values', () => {
    expect(() => loadConfig({ DATABASE_URL: 'PRIVATE', REDIS_URL: 'redis://localhost' }))
      .toThrow('Invalid environment configuration: DATABASE_URL');
  });

  it('rejects unsupported connection protocols and invalid ports without echoing secrets', () => {
    expect(() => loadConfig({ DATABASE_URL: 'https://PRIVATE', REDIS_URL: 'http://PRIVATE', PORT: '70000' }))
      .toThrow('Invalid environment configuration: DATABASE_URL, REDIS_URL, PORT');
  });

  it('requires database and Redis configuration', () => {
    expect(() => loadConfig({})).toThrow('DATABASE_URL, REDIS_URL');
  });
});
