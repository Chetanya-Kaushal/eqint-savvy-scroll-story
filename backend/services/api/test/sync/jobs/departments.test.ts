import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { prisma } from '../../../src/db';
import { runDepartmentSync } from '../../../src/sync/jobs/departments';

describe('runDepartmentSync', () => {
  let tenantId: string;

  beforeEach(async () => {
    await prisma.auditLog.deleteMany();
    await prisma.referenceRecord.deleteMany();
    await prisma.user.deleteMany();
    await prisma.tenant.deleteMany();
    const tenant = await prisma.tenant.create({
      data: { name: 'Acme', oracleBaseUrl: 'https://acme.example.com', oracleServiceUser: 'svc', oracleServicePass: 'plaintext-in-slice-1' },
    });
    tenantId = tenant.id;
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('fetches departments from Oracle and upserts them as ReferenceRecord rows', async () => {
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ items: [{ DepartmentId: '100', Name: 'Engineering' }, { DepartmentId: '200', Name: 'Sales' }] }),
    }) as unknown as typeof fetch;

    const result = await runDepartmentSync(tenantId);
    expect(result.count).toBe(2);

    const rows = await prisma.referenceRecord.findMany({ where: { tenantId, category: 'department' } });
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.externalId).sort()).toEqual(['100', '200']);

    const auditRows = await prisma.auditLog.findMany({ where: { tenantId, action: 'reference_sync' } });
    expect(auditRows).toHaveLength(1);
  });

  it('throws if the tenant has no Oracle connection configured', async () => {
    const unconfigured = await prisma.tenant.create({ data: { name: 'NoOracle', oracleBaseUrl: '' } });
    await expect(runDepartmentSync(unconfigured.id)).rejects.toThrow('Oracle connection not configured');
  });
});
