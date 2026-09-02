import Fastify, { FastifyInstance } from 'fastify';
import { registerPlatformAdminRoutes } from './routes/platform-admin';
import { registerTenantAdminRoutes } from './routes/tenant-admin';
import { registerAuthRoutes } from './routes/auth';
import { registerDataRoutes } from './routes/data';

export function buildServer(): FastifyInstance {
  const server = Fastify({ logger: true });

  server.get('/health', async () => ({ status: 'ok' }));

  registerPlatformAdminRoutes(server);
  registerTenantAdminRoutes(server);
  registerAuthRoutes(server);
  registerDataRoutes(server);

  return server;
}

if (require.main === module) {
  const { startScheduler } = require('./sync/scheduler');
  startScheduler();
  const { startRetentionScheduler } = require('./retention/scheduler');
  startRetentionScheduler();
  const server = buildServer();
  server.listen({ port: 4000, host: '0.0.0.0' }).catch((err) => {
    server.log.error(err);
    process.exit(1);
  });
}
