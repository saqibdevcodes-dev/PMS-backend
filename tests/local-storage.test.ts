import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import express, { type ErrorRequestHandler } from 'express';
import helmet from 'helmet';
import request from 'supertest';
import { LocalStorage } from '../src/integrations/local-storage.js';
import { AppError } from '../src/common/errors.js';

const signingKey = 'test-only-stable-download-signing-secret';
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aK1cAAAAASUVORK5CYII=',
  'base64',
);
let temporary: string;
let storage: LocalStorage;

function appFor(store: LocalStorage) {
  const app = express();
  app.use(helmet());
  store.routes(app);
  const errors: ErrorRequestHandler = (error, _req, res, _next) => {
    res.status(error instanceof AppError ? error.status : 500).json({ code: error.code });
  };
  app.use(errors);
  return app;
}

function downloadPath(url: string) {
  const parsed = new URL(url);
  expect(parsed.origin).toBe('https://api.example.test');
  return parsed.pathname + parsed.search;
}

beforeEach(async () => {
  temporary = await mkdtemp(join(tmpdir(), 'pms-local-storage-'));
  storage = new LocalStorage({
    directory: join(temporary, '.private', 'uploads'),
    publicUrl: 'https://api.example.test',
    signingKey,
  });
  await storage.ensure();
});

afterEach(async () => {
  vi.restoreAllMocks();
  await rm(temporary, { recursive: true, force: true });
});

describe('local uploads and private downloads', () => {
  it('persists image bytes and serves them after recreating the storage instance', async () => {
    await storage.put('images/photo.png', png);
    const url = storage.signedDownload('images/photo.png', 'photo.png', true);
    const restarted = new LocalStorage({
      directory: storage.directory,
      publicUrl: 'https://api.example.test',
      signingKey,
    });
    const response = await request(appFor(restarted)).get(downloadPath(url)).expect(200);
    expect(response.body).toEqual(png);
    expect(response.headers['content-type']).toMatch(/^image\/png/);
    expect(response.headers['content-disposition']).toBe("inline; filename*=UTF-8''photo.png");
    expect(response.headers['cross-origin-resource-policy']).toBe('cross-origin');
    expect(response.headers['cache-control']).toBe('private, no-store');
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(await readFile(join(storage.directory, 'images/photo.png'))).toEqual(png);
    expect(await readdir(join(storage.directory, 'images'))).toEqual(['photo.png']);
    await restarted.check();
  });

  it.each([
    ['projects/project/documents/report.pdf', 'application/pdf'],
    [
      'projects/project/exports/report.xlsx',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    ],
    ['portal-statements/customer/statement.pdf', 'application/pdf'],
  ])('serves documents and worker artifacts: %s', async (key, mime) => {
    await storage.put(key, Buffer.from('artifact bytes'));
    const url = storage.signedDownload(key, "Customer's report.pdf");
    const response = await request(appFor(storage)).get(downloadPath(url)).expect(200);
    expect(response.headers['content-type']).toMatch(new RegExp(`^${mime}`));
    expect(response.headers['content-disposition']).toBe(
      "attachment; filename*=UTF-8''Customer%27s%20report.pdf",
    );
  });

  it('requires a signed link and never exposes the uploads directory directly', async () => {
    await storage.put('images/photo.png', png);
    const app = appFor(storage);
    await request(app).get('/api/v1/files').expect(403);
    await request(app).get('/api/v1/files?token=invalid').expect(403);
    await request(app).get('/uploads/images/photo.png').expect(404);
    await request(app).get('/api/v1/files?key=images/photo.png').expect(403);
  });

  it('rejects a changed object key or a link signed by a different secret', async () => {
    await storage.put('images/photo.png', png);
    const url = new URL(storage.signedDownload('images/photo.png'));
    const [payload, signature] = url.searchParams.get('token')!.split('.');
    const data = JSON.parse(Buffer.from(payload!, 'base64url').toString('utf8'));
    data.key = 'images/private.png';
    url.searchParams.set(
      'token',
      `${Buffer.from(JSON.stringify(data)).toString('base64url')}.${signature}`,
    );
    await request(appFor(storage)).get(downloadPath(url.toString())).expect(403);
    const differentSecret = new LocalStorage({
      directory: storage.directory,
      publicUrl: 'https://api.example.test',
      signingKey: signingKey + '-different',
    });
    await request(appFor(storage))
      .get(downloadPath(differentSecret.signedDownload('images/photo.png')))
      .expect(403);
  });

  it('expires links after 120 seconds', async () => {
    await storage.put('images/photo.png', png);
    const now = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now - 121000);
    const expired = storage.signedDownload('images/photo.png');
    clock.mockRestore();
    await request(appFor(storage)).get(downloadPath(expired)).expect(403);
  });

  it('returns 404 for an authorized link to a missing file', async () => {
    const response = await request(appFor(storage))
      .get(downloadPath(storage.signedDownload('images/missing.png')))
      .expect(404);
    expect(response.body.code).toBe('FILE_NOT_FOUND');
  });

  it.each([
    '../secret.png',
    '/secret.png',
    'images/../../secret.png',
    'images\\secret.png',
    'images/%2e%2e/secret.png',
  ])('rejects unsafe paths: %s', async (key) => {
    await expect(storage.put(key, png)).rejects.toThrow('Invalid storage key');
    expect(() => storage.signedDownload(key)).toThrow('Invalid storage key');
  });

  it('cannot read or write through a directory symlink outside the upload root', async () => {
    const outside = join(temporary, 'outside');
    await mkdir(outside);
    await writeFile(join(outside, 'private.png'), png);
    await symlink(outside, join(storage.directory, 'images'), 'junction');
    await expect(storage.put('images/new.png', png)).rejects.toThrow('Invalid upload directory');
    await request(appFor(storage))
      .get(downloadPath(storage.signedDownload('images/private.png')))
      .expect(403);
    expect(await readdir(outside)).toEqual(['private.png']);
  });
});
