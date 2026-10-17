import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.mts', 'foreman/test/**/*.test.mts'],
    // The launcher and page builder run as child processes; a cold start can take a few seconds.
    testTimeout: 30_000,
  },
});
