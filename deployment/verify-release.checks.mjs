import assert from 'node:assert/strict';
import { test } from 'node:test';
import { verifyRelease } from './verify-release.mjs';

const revision = 'a'.repeat(40);
const calendar = '/projects/{projectId}/installment-calendar';
const contract = {
  openapi: '3.1.0',
  paths: { [calendar]: { get: {} }, [calendar + '/day']: { get: {} } },
};

function fixture({
  liveRevision = revision,
  deployed = contract,
  ready = true,
  calendarStatus = 401,
} = {}) {
  const requests = [];
  return {
    requests,
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      if (url.pathname === '/health/live')
        return globalThis.Response.json({ status: 'ok', revision: liveRevision });
      if (url.pathname === '/health/ready')
        return globalThis.Response.json(
          { status: ready ? 'ready' : 'unavailable' },
          { status: ready ? 200 : 503 },
        );
      if (url.pathname === '/api/v1/openapi.json') return globalThis.Response.json(deployed);
      return globalThis.Response.json({ success: false }, { status: calendarStatus });
    },
  };
}

async function check(overrides = {}, expected = contract) {
  const mock = fixture(overrides);
  const result = await verifyRelease({
    baseUrl: 'https://api.example.test',
    revision,
    contract: expected,
    fetchImpl: mock.fetchImpl,
  });
  return { result, requests: mock.requests };
}

test('verifies revision, dependencies, complete contract and both protected calendar routes', async () => {
  const { result, requests } = await check();
  assert.equal(result.status, 'verified');
  assert.equal(requests.length, 5);
  assert(
    requests.every(
      ({ url, options }) =>
        url.searchParams.get('release-check') === revision &&
        options.headers['Cache-Control'] === 'no-cache',
    ),
  );
});

test('rejects an old API behind a successful HTTP response', async () => {
  await assert.rejects(check({ liveRevision: 'b'.repeat(40) }), /different release/);
});

test('rejects missing production calendar routes', async () => {
  await assert.rejects(
    check({ deployed: { openapi: '3.1.0', paths: {} } }),
    /Production is missing GET/,
  );
});

test('rejects an artifact that omitted the calendar code and contract', async () => {
  await assert.rejects(
    check({}, { openapi: '3.1.0', paths: {} }),
    /Release artifact is missing GET/,
  );
});

test('rejects any other contract mismatch', async () => {
  await assert.rejects(
    check({ deployed: { ...contract, info: { version: 'old' } } }),
    /contract differs/,
  );
});

test('rejects unhealthy dependencies', async () => {
  await assert.rejects(check({ ready: false }), /HTTP 503/);
});

test('rejects a calendar path that is documented but returns endpoint-not-found', async () => {
  await assert.rejects(check({ calendarStatus: 404 }), /HTTP 404/);
});
