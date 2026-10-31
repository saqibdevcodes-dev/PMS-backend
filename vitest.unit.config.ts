import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: [
      'tests/money.test.ts',
      'tests/security.test.ts',
      'tests/contracts.test.ts',
      'tests/auth-http.test.ts',
      'tests/admin-recovery.test.ts',
      'tests/portal.test.ts',
      'tests/form-images.test.ts',
      'tests/local-storage.test.ts',
      'tests/project-branding.test.ts',
      'tests/export-layout.test.ts',
      'tests/dependency-compatibility.test.ts',
      'tests/email.test.ts',
    ],
    testTimeout: 20000,
    setupFiles: ['tests/unit-env.ts'],
  },
});
