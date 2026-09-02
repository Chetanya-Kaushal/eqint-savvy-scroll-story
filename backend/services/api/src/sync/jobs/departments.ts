import { prisma } from '../../db';
import { writeAuditLog } from '../../audit/log';
import { fetchOracleResource } from '../oracle-client';

export async function runDepartmentSync(tenantId: string): Promise<{ count: number }> {
  const tenant = await prisma.tenant.findUniqueOrThrow({ where: { id: tenantId } });
  const { items } = await fetchOracleResource(tenant, '/departments?onlyData=true&limit=200');

  for (const item of items) {
    const externalId = String(item.DepartmentId ?? item.Name);
    await prisma.referenceRecord.upsert({
      where: { tenantId_category_externalId: { tenantId, category: 'department', externalId } },
      create: { tenantId, category: 'department', externalId, data: item },
      update: { data: item, syncedAt: new Date() },
    });
  }

  await writeAuditLog({ tenantId, actor: 'system:sync-scheduler', action: 'reference_sync', scope: 'department' });
  return { count: items.length };
}
