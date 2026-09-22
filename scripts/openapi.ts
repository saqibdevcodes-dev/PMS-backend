import { writeFile } from 'node:fs/promises';
import { createApp } from '../src/app.js';
import { buildOpenApi } from '../src/docs/openapi.js';
import { db } from '../src/database/client.js';
import { redis } from '../src/integrations/redis.js';
createApp();
await writeFile('docs/openapi.json', JSON.stringify(buildOpenApi(), null, 2) + '\n');
await db.$disconnect();
redis.disconnect();
