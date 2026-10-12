import { buildApp } from './app.js';
import { loadConfig } from './config/env.js';

async function main() {
  const config = loadConfig();
  const app = buildApp(config);
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => {
      void app.close().catch(() => { process.exitCode = 1; });
    });
  }
  try {
    await app.listen({ host: config.HOST, port: config.PORT });
  } catch {
    await app.close();
    throw new Error('API startup failed; check the host and port configuration');
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'API startup failed');
  process.exitCode = 1;
});
