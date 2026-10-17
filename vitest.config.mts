import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // foreman's own tests use node:test and run with `node --test`; its verify runner's tests run here.
    include: ['tests/**/*.test.mts', 'foreman/test/verify/**/*.test.mts'],
    // The launcher and page builder run as child processes; a cold start can take a few seconds.
    testTimeout: 30_000,
  },
});
