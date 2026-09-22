import { afterAll, describe, it, expect } from 'vitest';
import { createApp } from '../src/app.js';
import { routeDocs } from '../src/common/http.js';
import { buildOpenApi } from '../src/docs/openapi.js';
import { db } from '../src/database/client.js';
import { redis } from '../src/integrations/redis.js';
import { storage } from '../src/integrations/storage.js';

createApp();
const spec = buildOpenApi();

afterAll(async () => {
  await db.$disconnect();
  redis.disconnect();
  storage.destroy();
});

describe('generated API contract', () => {
  it('documents every registered operation exactly once', () => {
    const documented = Object.entries(spec.paths).flatMap(([path, methods]) =>
      Object.keys(methods).map((method) => method + ' ' + path),
    );
    expect(documented.length).toBe(routeDocs.length);
    expect(new Set(documented).size).toBe(documented.length);
    expect(spec.paths['/projects/{projectId}/payments/{id}/allocate-advance']).toBeDefined();
    expect(spec.paths['/auth/native/refresh']).toBeDefined();
  });

  it('resolves all schema references in requests and responses', () => {
    const references = [
      ...JSON.stringify(spec).matchAll(/"\$ref":"#\/components\/schemas\/([^"/]+)"/g),
    ];
    expect(references.length).toBeGreaterThan(100);
    for (const [, name] of references) expect(spec.components.schemas, name).toHaveProperty(name!);
  });

  it('keeps every project operation authenticated and permission scoped', () => {
    const projectRoutes = routeDocs.filter((route) =>
      route.path.startsWith('/projects/:projectId'),
    );
    expect(projectRoutes.length).toBeGreaterThan(70);
    for (const route of projectRoutes) {
      expect(route.public, route.path).not.toBe(true);
      // Approval handlers check the requested operation's permission inside the transaction.
      const operationPermission = [
        '/projects/:projectId/approvals/:id/decide',
        '/projects/:projectId/approvals/:id/resubmit',
      ].includes(route.path);
      expect(Boolean(route.permission) || operationPermission, route.path).toBe(true);
    }
  });

  it('does not publish secret or internal database fields', () => {
    const schemas = JSON.stringify(spec.components.schemas);
    for (const field of [
      'passwordHash',
      'identityEncrypted',
      'identityHash',
      'pushToken',
      'createdTransaction',
    ]) {
      expect(schemas).not.toContain('"' + field + '"');
    }
  });

  it('describes exact money as strings and multipart uploads as binary', () => {
    expect(spec.components.schemas.Money).toMatchObject({ type: 'string' });
    expect(spec.paths['/projects/{projectId}/documents']?.post).toMatchObject({
      requestBody: {
        content: {
          'multipart/form-data': {
            schema: {
              properties: { file: { type: 'string', format: 'binary' } },
              required: expect.arrayContaining(['file']),
            },
          },
        },
      },
    });
  });

  it('requires idempotency keys on collection creation and verification', () => {
    for (const path of [
      '/projects/{projectId}/payments',
      '/projects/{projectId}/payments/{id}/verify',
    ]) {
      expect(spec.paths[path]?.post).toMatchObject({
        parameters: expect.arrayContaining([
          expect.objectContaining({ name: 'Idempotency-Key', in: 'header', required: true }),
        ]),
      });
    }
  });
});
