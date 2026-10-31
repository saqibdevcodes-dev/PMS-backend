import { defineConfig, configDefaults } from 'vitest/config';
export default defineConfig({
  test: {
    exclude: [...configDefaults.exclude, '.runtime/**'],
    testTimeout: 30000,
    hookTimeout: 120000,
    fileParallelism: false,
    setupFiles: ['tests/env.ts'],
    globalSetup: ['tests/database.ts'],
  },
});
