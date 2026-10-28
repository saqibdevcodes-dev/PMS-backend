import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { constants } from 'node:fs';
import {
  access,
  lstat,
  mkdir,
  realpath,
  readFile,
  rename,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { Express } from 'express';
import { z } from 'zod';
import { AppError } from '../common/errors.js';

const download = z.strictObject({
  key: z.string().max(1024),
  name: z.string().max(512).optional(),
  inline: z.boolean(),
  expires: z.number().int(),
});
const mimeTypes: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.pdf': 'application/pdf',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.doc': 'application/msword',
};
const forbidden = () =>
  new AppError(403, 'INVALID_DOWNLOAD', 'Download link is invalid or expired.');
const missing = () => new AppError(404, 'FILE_NOT_FOUND', 'File not found.');
const missingPath = (error: unknown) =>
  ['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '');

function segments(key: string) {
  const parts = key.split('/');
  if (
    key.length > 1024 ||
    parts.some((part) => !/^[a-zA-Z0-9][a-zA-Z0-9_-]*(?:\.[a-zA-Z0-9_-]+)*$/.test(part))
  )
    throw new Error('Invalid storage key');
  return parts;
}

function contained(root: string, path: string) {
  const child = relative(root, path);
  return child !== '' && child !== '..' && !child.startsWith(`..${sep}`) && !isAbsolute(child);
}

export class LocalStorage {
  readonly directory: string;

  constructor(
    private readonly options: { directory: string; publicUrl: string; signingKey: string },
  ) {
    this.directory = resolve(options.directory);
  }

  async ensure() {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await this.check();
  }

  async check() {
    if (!(await stat(this.directory)).isDirectory())
      throw new Error('UPLOAD_DIR is not a directory');
    await access(this.directory, constants.R_OK | constants.W_OK);
  }

  async put(key: string, body: Buffer) {
    const parts = segments(key);
    await this.ensure();
    let parent = await realpath(this.directory);
    for (const part of parts.slice(0, -1)) {
      parent = join(parent, part);
      await mkdir(parent, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'EEXIST') throw error;
      });
      const info = await lstat(parent);
      if (info.isSymbolicLink() || !info.isDirectory()) throw new Error('Invalid upload directory');
    }
    // Rename only after all bytes are written, so readers never receive a partial file.
    const temporary = join(parent, `.${randomUUID()}.tmp`);
    try {
      await writeFile(temporary, body, { flag: 'wx', mode: 0o600 });
      await rename(temporary, join(parent, parts.at(-1)!));
    } finally {
      await unlink(temporary).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error;
      });
    }
  }

  signedDownload(key: string, name?: string, inline = false) {
    segments(key);
    const payload = download.parse({
      key,
      name,
      inline,
      expires: Math.floor(Date.now() / 1000) + 120,
    });
    const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const token = `${encoded}.${this.signature(encoded).toString('base64url')}`;
    const url = new URL('/api/v1/files', this.options.publicUrl);
    url.searchParams.set('token', token);
    return url.toString();
  }
  async read(key: string, maxBytes: number) {
    const root = await realpath(this.directory);
    const path = await realpath(join(root, ...segments(key)));
    if (!contained(root, path)) throw forbidden();
    const info = await stat(path);
    if (!info.isFile()) throw missing();
    if (info.size > maxBytes) throw new Error('Stored image exceeds the size limit');
    const body = await readFile(path);
    if (body.length > maxBytes) throw new Error('Stored image exceeds the size limit');
    return body;
  }

  private signature(payload: string) {
    return createHmac('sha256', this.options.signingKey)
      .update('pms:local-download:v1\0')
      .update(payload)
      .digest();
  }

  private verify(token: unknown) {
    if (typeof token !== 'string' || token.length > 4096) throw forbidden();
    const match = /^([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)$/.exec(token);
    if (!match) throw forbidden();
    const payload = match[1]!;
    const signature = Buffer.from(match[2]!, 'base64url');
    const expected = this.signature(payload);
    if (signature.length !== expected.length || !timingSafeEqual(signature, expected))
      throw forbidden();
    try {
      const data = download.parse(JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')));
      segments(data.key);
      if (data.expires <= Math.floor(Date.now() / 1000)) throw forbidden();
      return data;
    } catch {
      throw forbidden();
    }
  }

  routes(app: Express) {
    // The authenticated image/document endpoints issue these short-lived capabilities.
    // Keep the token in the query string, which the application logger omits.
    app.get('/api/v1/files', async (req, res, next) => {
      res.setHeader('Cache-Control', 'private, no-store');
      const data = this.verify(req.query.token);
      let root: string;
      let path: string;
      try {
        root = await realpath(this.directory);
        path = await realpath(join(root, ...segments(data.key)));
        if (!contained(root, path)) throw forbidden();
        if (!(await stat(path)).isFile()) throw missing();
      } catch (error) {
        throw missingPath(error) ? missing() : error;
      }
      res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader(
        'Content-Disposition',
        (data.inline ? 'inline' : 'attachment') +
          (data.name
            ? `; filename*=UTF-8''${encodeURIComponent(data.name).replace(/'/g, '%27')}`
            : ''),
      );
      res.type(mimeTypes[extname(data.key).toLowerCase()] ?? 'application/octet-stream');
      res.sendFile(
        relative(root, path),
        { root, cacheControl: false, lastModified: false, dotfiles: 'deny' },
        (error) => {
          if (!error) return;
          if (res.headersSent) {
            res.destroy(error);
            return;
          }
          next(missingPath(error) ? missing() : error);
        },
      );
    });
  }
}
