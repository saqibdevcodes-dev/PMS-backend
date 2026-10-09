import { z } from 'zod';
import modelMetadata from './models.json' with { type: 'json' };
import { responseSchema, extraSchemas } from './responses.js';
import { routeDocs } from '../common/http.js';
import { portalContract } from '../modules/portal/contracts.js';
export function buildOpenApi() {
  const schemas: Record<string, unknown> = {
    Money: {
      type: 'string',
      pattern: '^-?[0-9]+(\\.[0-9]{1,2})?$',
      examples: ['1250000.00'],
      description: 'Exact decimal string; never a JSON floating point number.',
    },
    Error: {
      type: 'object',
      required: ['success', 'error', 'meta'],
      properties: {
        success: { const: false },
        error: {
          type: 'object',
          required: ['code', 'message'],
          properties: { code: { type: 'string' }, message: { type: 'string' }, details: {} },
        },
        meta: { type: 'object', properties: { requestId: { type: 'string' } } },
      },
    },
  };
  for (const model of modelMetadata.models) {
    const properties: Record<string, unknown> = {};
    for (const field of model.fields) {
      if (
        [
          'passwordHash',
          'identityEncrypted',
          'identityHash',
          'hash',
          'pushToken',
          'createdTransaction',
        ].includes(field.name)
      )
        continue;
      let schema: Record<string, unknown> =
        field.kind === 'object'
          ? { $ref: '#/components/schemas/' + field.type }
          : field.type === 'Decimal'
            ? { $ref: '#/components/schemas/Money' }
            : field.type === 'DateTime'
              ? { type: 'string', format: 'date-time' }
              : field.type === 'Int'
                ? { type: 'integer' }
                : field.type === 'Boolean'
                  ? { type: 'boolean' }
                  : field.type === 'Json'
                    ? {}
                    : { type: 'string' };
      if (field.kind === 'enum')
        schema = {
          type: 'string',
          enum: modelMetadata.enums.find((e) => e.name === field.type)?.values.map((v) => v.name),
        };
      if (field.isList) schema = { type: 'array', items: schema };
      if (!field.isRequired) schema = { anyOf: [schema, { type: 'null' }] };
      properties[field.name] = schema;
    }
    schemas[model.name] = { type: 'object', properties };
  }
  Object.assign(schemas, extraSchemas);
  const paths: Record<string, Record<string, unknown>> = {};
  for (const route of routeDocs) {
    const portalResponse = portalContract(route.path, route.method);
    const path = route.path.replace(/:([A-Za-z]+)/g, '{$1}');
    const parameters: unknown[] = [];
    for (const match of route.path.matchAll(/:([A-Za-z]+)/g))
      parameters.push({
        name: match[1],
        in: 'path',
        required: true,
        schema: { type: 'string', format: 'uuid' },
      });
    if (route.query) {
      const query = z.toJSONSchema(route.query, { io: 'input', unrepresentable: 'any' }) as {
        properties?: Record<string, unknown>;
        required?: string[];
      };
      for (const [name, schema] of Object.entries(query.properties ?? {}))
        parameters.push({
          name,
          in: 'query',
          required: query.required?.includes(name) ?? false,
          schema,
        });
    }
    if (route.summary.includes('Idempotency-Key'))
      parameters.push({
        name: 'Idempotency-Key',
        in: 'header',
        required: true,
        schema: { type: 'string', minLength: 8, maxLength: 128, pattern: '^[\\w-]+$' },
      });
    const body = route.body
      ? z.toJSONSchema(route.body, { io: 'input', unrepresentable: 'any' })
      : undefined;
    if (body && route.multipart) {
      body.properties = { ...body.properties, file: { type: 'string', format: 'binary' } };
      body.required = [...(body.required ?? []), 'file'];
    }
    const responses: Record<string, unknown> = {};
    for (const status of [400, 401, 403, 404, 409, 422, 429, 500])
      responses[String(status)] = {
        description: (
          {
            400: 'Malformed request',
            401: 'Invalid, expired or revoked session',
            403: 'Permission, origin or separation-of-duties denial',
            404: 'Record missing or outside project scope',
            409: 'Workflow, uniqueness or concurrency conflict',
            422: 'Validation or business rule failure',
            429: 'Distributed rate limit',
            500: 'Unexpected server error',
          } as Record<number, string>
        )[status],
        content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } },
      };
    responses[String(route.status ?? 200)] = {
      description:
        'Successful operation. Monetary model fields are decimal strings. Lists with pagination return items and pagination inside data.',
      content: {
        'application/json': {
          schema: {
            type: 'object',
            required: ['success', 'data', 'meta'],
            properties: {
              success: { const: true },
              data:
                route.response || portalResponse
                  ? z.toJSONSchema((route.response || portalResponse)!)
                  : route.path === '/metrics'
                    ? { type: 'string' }
                    : responseSchema(
                        route.path,
                        route.method,
                        Boolean(
                          route.query &&
                          'properties' in
                            z.toJSONSchema(route.query, { io: 'input', unrepresentable: 'any' }) &&
                          (
                            z.toJSONSchema(route.query, { io: 'input', unrepresentable: 'any' })
                              .properties ?? {}
                          ).page,
                        ),
                      ),
              meta: {
                type: 'object',
                required: ['requestId'],
                properties: { requestId: { type: 'string' } },
              },
            },
          },
        },
      },
    };
    if (route.path === '/metrics')
      responses['200'] = {
        description: 'Prometheus metrics',
        content: { 'text/plain': { schema: { type: 'string' } } },
      };
    (paths[path] ??= {})[route.method] = {
      operationId: route.method + '_' + route.path.replace(/[^a-zA-Z0-9]/g, '_'),
      summary: route.summary,
      tags: [route.path.split('/').filter(Boolean)[route.path.startsWith('/projects/:') ? 2 : 0]],
      security: route.public ? [] : [{ bearerAuth: [] }],
      parameters,
      ...(body
        ? {
            requestBody: {
              required: true,
              content: {
                [route.multipart ? 'multipart/form-data' : 'application/json']: { schema: body },
              },
            },
          }
        : {}),
      responses,
      'x-permission': route.permission ?? null,
      'x-audience': route.public ? 'public' : (route.audience ?? 'staff'),
    };
  }
  return {
    openapi: '3.1.0',
    info: {
      title: 'Enterprise PMS API',
      version: '1.0.0',
      description:
        'Centralized online-first PMS. All project paths require explicit project membership. Web refresh cookies require a trusted Origin. Native routes return refresh tokens only for OS secure storage. Financial values are decimal strings. Critical workflows use immutable records, approval checks and serializable transactions.',
    },
    servers: [{ url: '/api/v1' }],
    paths,
    components: {
      securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' } },
      schemas,
    },
  };
}
