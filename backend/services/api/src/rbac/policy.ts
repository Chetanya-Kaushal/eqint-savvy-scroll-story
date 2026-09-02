import { FastifyReply, FastifyRequest } from 'fastify';
import { verifySessionToken, SessionClaims } from '../auth/session';

export async function requireAuth(request: FastifyRequest, reply: FastifyReply) {
  const header = request.headers.authorization;
  if (!header?.startsWith('Bearer ')) return reply.code(401).send({ error: 'Missing bearer token' });
  const claims = verifySessionToken(header.slice('Bearer '.length));
  if (!claims) return reply.code(401).send({ error: 'Invalid or expired token' });
  (request as FastifyRequest & { session: SessionClaims }).session = claims;
}

export function requireRole(role: string) {
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const header = request.headers.authorization;
    if (!header?.startsWith('Bearer ')) {
      reply.code(401).send({ error: 'Missing bearer token' });
      return;
    }
    const claims = verifySessionToken(header.slice('Bearer '.length));
    if (!claims) {
      reply.code(401).send({ error: 'Invalid or expired token' });
      return;
    }
    if (claims.role !== role) {
      reply.code(403).send({ error: 'Insufficient role' });
      return;
    }
    (request as FastifyRequest & { session: typeof claims }).session = claims;
  };
}
