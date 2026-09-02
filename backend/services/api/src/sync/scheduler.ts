import cron from 'node-cron';
import { prisma } from '../db';
import { runDepartmentSync } from './jobs/departments';

export function startScheduler(): void {
  cron.schedule('0 * * * *', async () => {
    const tenants = await prisma.tenant.findMany({ where: { oracleBaseUrl: { not: '' } } });
    for (const tenant of tenants) {
      try {
        await runDepartmentSync(tenant.id);
      } catch (err) {
        console.error(`Department sync failed for tenant ${tenant.id}:`, err);
      }
    }
  });
}
