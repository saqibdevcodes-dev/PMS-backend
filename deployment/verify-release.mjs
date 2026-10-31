import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const calendarPaths = [
  '/projects/{projectId}/installment-calendar',
  '/projects/{projectId}/installment-calendar/day',
];

export async function verifyRelease({ baseUrl, revision, contract, fetchImpl = globalThis.fetch }) {
  assert.match(revision, /^[a-f0-9]{40}$/);
  const base = new URL(baseUrl);
  assert(['http:', 'https:'].includes(base.protocol));
  async function request(path, status = 200) {
    const url = new URL(path, base);
    url.searchParams.set('release-check', revision);
    const response = await fetchImpl(url, {
      headers: { 'Cache-Control': 'no-cache' },
      signal: globalThis.AbortSignal.timeout(15000),
      redirect: 'error',
    });
    assert.equal(response.status, status, `${path} returned HTTP ${response.status}`);
    return response.json();
  }

  const live = await request('/health/live');
  assert.equal(live.status, 'ok');
  assert.equal(live.revision, revision, 'The public API is serving a different release');
  assert.equal((await request('/health/ready')).status, 'ready');
  const deployed = await request('/api/v1/openapi.json');
  assert.equal(deployed.openapi, '3.1.0');
  for (const path of calendarPaths) {
    assert(contract.paths?.[path]?.get, `Release artifact is missing GET ${path}`);
    assert(deployed.paths?.[path]?.get, `Production is missing GET ${path}`);
  }
  assert.deepEqual(deployed, contract, 'Production API contract differs from the release artifact');

  // A registered protected route must reject anonymous access before looking up the project.
  const project = '00000000-0000-4000-8000-000000000001';
  for (const path of calendarPaths) {
    const query = path.endsWith('/day') ? '?date=2026-10-01' : '?from=2026-10-01&to=2026-10-31';
    const response = await request('/api/v1' + path.replace('{projectId}', project) + query, 401);
    assert.equal(response.success, false);
  }
  return { revision, status: 'verified', calendarRoutes: calendarPaths.length };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [, , revision, contractPath, baseUrl = 'https://api.etihadrealestate.tech'] = process.argv;
  const contract = JSON.parse(await readFile(contractPath, 'utf8'));
  console.log(JSON.stringify(await verifyRelease({ baseUrl, revision, contract })));
}
