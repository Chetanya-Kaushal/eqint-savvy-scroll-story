import Fastify, { FastifyInstance } from 'fastify';

export function buildServer(): FastifyInstance {
  const server = Fastify({ logger: true });

  server.get('/health', async () => ({ status: 'ok' }));

  return server;
}

if (require.main === module) {
  const server = buildServer();
  server.listen({ port: 4000, host: '0.0.0.0' }).catch((err) => {
    server.log.error(err);
    process.exit(1);
  });
}
