import 'dotenv/config';
import assert from 'node:assert/strict';

const base = `http://127.0.0.1:${Number(process.env.PORT ?? 4000)}`;
const results = {};
let accessToken;

async function request(path, options = {}) {
  const response = await globalThis.fetch(base + path, {
    ...options,
    signal: globalThis.AbortSignal.timeout(15000),
  });
  assert.equal(response.status, 200, `${path} returned HTTP ${response.status}`);
  return response.json();
}

try {
  assert(
    process.env.ADMIN_EMAIL && process.env.ADMIN_PASSWORD,
    'Set administrator credentials in .env before running the smoke check.',
  );
  assert.equal((await request('/health/live')).status, 'ok');
  results.liveness = 'passed';
  assert.equal((await request('/health/ready')).status, 'ready');
  results.databaseRedisStorage = 'passed';
  const contract = await request('/api/v1/openapi.json');
  assert.equal(contract.openapi, '3.1.0');
  assert(Object.keys(contract.paths).length >= 100);
  results.apiContract = 'passed';
  const login = await request('/api/v1/auth/native/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      email: process.env.ADMIN_EMAIL,
      password: process.env.ADMIN_PASSWORD,
      platform: 'electron',
      deviceId: 'local-runtime-smoke-check',
    }),
  });
  accessToken = login.data.accessToken;
  assert.equal(typeof accessToken, 'string');
  const headers = { Authorization: `Bearer ${accessToken}` };
  const me = await request('/api/v1/auth/me', { headers });
  assert.equal(me.data.email, process.env.ADMIN_EMAIL.toLowerCase());
  assert(me.data.permissions.includes('users.manage'));
  results.administratorLogin = 'passed';
  const projects = await request('/api/v1/projects', { headers });
  assert.equal(projects.success, true);
  assert(Array.isArray(projects.data.items));
  results.authenticatedRequest = 'passed';
} finally {
  if (accessToken) {
    const logout = await request('/api/v1/auth/logout', {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: '{}',
    });
    assert.equal(logout.data.loggedOut, true);
    results.sessionCleanup = 'passed';
  }
}

console.log(JSON.stringify({ base, checks: results }, null, 2));
