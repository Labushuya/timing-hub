import fp from 'fastify-plugin';
import { Redis } from 'ioredis';
import type { FastifyInstance } from 'fastify';

declare module 'fastify' {
  interface FastifyInstance {
    redis: InstanceType<typeof Redis>;
    redisSub: InstanceType<typeof Redis>;
  }
}

const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379';

const RECONNECT_MAX_DELAY_MS = 5000;

function createRedisClient(name: string, log: FastifyInstance['log']): InstanceType<typeof Redis> {
  const client = new Redis(REDIS_URL, {
    maxRetriesPerRequest: null, // required by BullMQ
    enableReadyCheck: true,
    retryStrategy(times: number) {
      const delay = Math.min(times * 200, RECONNECT_MAX_DELAY_MS);
      log.warn({ name, times, delay }, 'Redis reconnecting');
      return delay;
    },
    lazyConnect: true,
  });

  client.on('connect', () => log.info({ name }, 'Redis connected'));
  client.on('ready', () => log.info({ name }, 'Redis ready'));
  client.on('error', (err) => log.error({ name, err }, 'Redis error'));
  client.on('close', () => log.warn({ name }, 'Redis connection closed'));
  client.on('reconnecting', () => log.warn({ name }, 'Redis reconnecting'));
  client.on('end', () => log.warn({ name }, 'Redis connection ended'));

  return client;
}

async function redisPluginFn(app: FastifyInstance): Promise<void> {
  const redis = createRedisClient('redis', app.log);
  const redisSub = createRedisClient('redisSub', app.log);

  await Promise.all([redis.connect(), redisSub.connect()]);

  app.decorate('redis', redis);
  app.decorate('redisSub', redisSub);

  app.addHook('onClose', async () => {
    app.log.info('Closing Redis connections');
    await Promise.all([redis.quit(), redisSub.quit()]);
  });
}

export const redisPlugin = fp(redisPluginFn, {
  name: 'redis',
  fastify: '5.x',
});
