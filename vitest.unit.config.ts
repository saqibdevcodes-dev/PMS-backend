import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/money.test.ts', 'tests/security.test.ts', 'tests/contracts.test.ts'],
    setupFiles: ['tests/unit-env.ts'],
  },
});
