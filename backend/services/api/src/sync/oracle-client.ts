export interface TenantOracleConfig {
  oracleBaseUrl: string;
  oracleServiceUser: string | null;
  oracleServicePass: string | null;
}

export async function fetchOracleResource(tenant: TenantOracleConfig, resourcePath: string): Promise<{ items: Record<string, unknown>[] }> {
  if (!tenant.oracleBaseUrl || !tenant.oracleServiceUser || !tenant.oracleServicePass) {
    throw new Error('Oracle connection not configured');
  }
  const url = `${tenant.oracleBaseUrl}/hcmRestApi/resources/11.13.18.05${resourcePath}`;
  const auth = 'Basic ' + Buffer.from(`${tenant.oracleServiceUser}:${tenant.oracleServicePass}`).toString('base64');
  const response = await fetch(url, { headers: { Authorization: auth, Accept: 'application/json' } });
  if (!response.ok) throw new Error(`Oracle API error ${response.status} for ${resourcePath}`);
  return response.json() as Promise<{ items: Record<string, unknown>[] }>;
}
