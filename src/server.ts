import { createApp, logger } from './app.js';
import { env } from './config/env.js';
import { db } from './database/client.js';
import { redis } from './integrations/redis.js';
import { ensureStorage, storage } from './integrations/storage.js';
await db.$connect();
await redis.ping();
await ensureStorage();
const server = createApp().listen(env.PORT, () => logger.info({ port: env.PORT }, 'PMS API ready'));
async function shutdown() {
  server.close(async () => {
    await db.$disconnect();
    await redis.quit();
    storage.destroy();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 15000).unref();
}
process.on('SIGTERM', () => void shutdown());
process.on('SIGINT', () => void shutdown());
