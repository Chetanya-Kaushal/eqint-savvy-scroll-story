import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { prisma } from '../../src/db';
import { writeAuditLog } from '../../src/audit/log';

describe('writeAuditLog', () => {
  let tenantId: string;

  beforeEach(async () => {
    await prisma.auditLog.deleteMany();
    await prisma.user.deleteMany();
    await prisma.tenant.deleteMany();
    const tenant = await prisma.tenant.create({ data: { name: 'Acme', oracleBaseUrl: 'https://acme.example.com' } });
    tenantId = tenant.id;
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('persists an audit log row with the given fields', async () => {
    await writeAuditLog({ tenantId, actor: 'user-1', action: 'reference_sync', scope: 'departments' });
    const rows = await prisma.auditLog.findMany({ where: { tenantId } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ tenantId, actor: 'user-1', action: 'reference_sync', scope: 'departments' });
  });
});
