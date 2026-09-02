import { prisma } from '../db';

export async function writeAuditLog(entry: { tenantId: string | null; actor: string; action: string; scope: string }): Promise<void> {
  await prisma.auditLog.create({ data: entry });
}
