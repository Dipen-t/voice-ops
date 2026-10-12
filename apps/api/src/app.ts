import Fastify from 'fastify';
import type { Config } from './config/env.js';
import { createHealthDependencies, probe } from './health.js';
import type { HealthDependencies } from './health.js';
import { investigatorRoutes } from './investigator-routes.js';
import type { InvestigatorRuntime } from './investigator-runtime.js';
import staticFiles from '@fastify/static';
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { documentRoutes } from './document-routes.js';

export function buildApp(config: Config, dependencies?: HealthDependencies, investigator?:InvestigatorRuntime) {
  const health = dependencies ?? createHealthDependencies(config);
  const app = Fastify({
    logger: {
      level: config.LOG_LEVEL,
      redact: ['req.headers.authorization', 'req.headers.cookie','req.headers["x-session-token"]'],
    },
    bodyLimit: 16384,
    requestTimeout: 10000,
  });

  app.get('/health/live', async () => ({ status: 'ok' }));
  app.get('/app-config',async()=>({mode:config.ASSISTANT_MODE}));
  app.get('/health/ready', async (_request, reply) => {
    const [postgres, redis] = await Promise.all([
      probe(health.postgres, config.HEALTH_TIMEOUT_MS),
      probe(health.redis, config.HEALTH_TIMEOUT_MS),
    ]);
    const ready = postgres === 'up' && redis === 'up';
    reply.code(ready ? 200 : 503);
    return { status: ready ? 'ready' : 'not_ready', dependencies: { postgres, redis } };
  });
  app.addHook('onClose', () => health.close());
  if(config.INVESTIGATOR_ENABLED) {
    app.register(async scoped=>config.ASSISTANT_MODE==='documents'?documentRoutes(scoped,config):investigatorRoutes(scoped,config,investigator));
    if(existsSync(resolve('dist/web/index.html')))app.register(staticFiles,{root:resolve('dist/web'),prefix:'/'});
  }
  return app;
}
