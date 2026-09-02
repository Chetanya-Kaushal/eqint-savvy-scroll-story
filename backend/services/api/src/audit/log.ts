import { createHash } from 'crypto';
import { prisma } from '../db';

export async function writeAuditLog(entry: { tenantId: string | null; actor: string; action: string; scope: string }): Promise<void> {
  const payload = JSON.stringify({ tenantId: entry.tenantId, actor: entry.actor, action: entry.action, scope: entry.scope });
  const hash = createHash('sha256').update(payload).digest('hex');
  await prisma.auditLog.create({ data: { ...entry, hash } });
}
