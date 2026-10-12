import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['apps/**/tests/**/*.test.ts', 'packages/**/tests/**/*.test.ts', 'scripts/tests/**/*.test.ts'],
    // Cold Fastify inject imports on this Windows host exceeded Vitest's 5s default.
    // Application readiness deadlines remain 1500ms (tested independently).
    testTimeout: 30000,
    hookTimeout: 30000,
  },
});
