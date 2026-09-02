import { prisma } from '../db';

interface PurgeResult {
  conversationEntriesDeleted: number;
  expiredCacheEntriesDeleted: number;
}

export async function runRetentionPurge(): Promise<PurgeResult> {
  const tenants = await prisma.tenant.findMany({ select: { id: true, retentionDays: true } });

  let conversationEntriesDeleted = 0;
  let expiredCacheEntriesDeleted = 0;

  for (const tenant of tenants) {
    const cutoff = new Date(Date.now() - tenant.retentionDays * 24 * 60 * 60 * 1000);

    const users = await prisma.user.findMany({ where: { tenantId: tenant.id }, select: { id: true } });
    const userIds = users.map(u => u.id);

    if (userIds.length > 0) {
      const { count } = await prisma.conversationEntry.deleteMany({
        where: { userId: { in: userIds }, createdAt: { lt: cutoff } },
      });
      conversationEntriesDeleted += count;
    }
  }

  const { count: cacheCount } = await prisma.personDataCache.deleteMany({
    where: { expiresAt: { lt: new Date() } },
  });
  expiredCacheEntriesDeleted += cacheCount;

  return { conversationEntriesDeleted, expiredCacheEntriesDeleted };
}
