import { afterAll, beforeAll, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import type { Writable } from 'node:stream';

const require = createRequire(import.meta.url);
const archiveFiles = require('archiver-utils').file as {
  expand(options: { cwd: string }, patterns: string[]): string[];
};
const fstream = require('fstream') as {
  Writer(options: { path: string; type: 'File' }): Writable;
};
let directory: string;
beforeAll(async () => {
  await mkdir('.runtime', { recursive: true });
  directory = await mkdtemp(resolve('.runtime/dependency-compat-'));
  await mkdir(join(directory, 'nested'));
  await writeFile(join(directory, 'keep.txt'), 'keep');
  await writeFile(join(directory, 'skip.txt'), 'skip');
  await writeFile(join(directory, 'nested/inside.txt'), 'inside');
});
afterAll(async () => {
  if (!directory) return;
  const target = resolve(directory);
  if (!target.startsWith(resolve('.runtime') + sep)) throw new Error('Unsafe fixture cleanup');
  await rm(target, { recursive: true, force: true });
});

it('preserves archive file expansion and exclusions with the patched matcher', () => {
  expect(archiveFiles.expand({ cwd: directory }, ['**/*.txt', '!skip.txt']).sort()).toEqual([
    'keep.txt',
    join('nested', 'inside.txt'),
  ]);
});

it('preserves the archive writer callback cleanup when replacing a directory with a file', async () => {
  const target = join(directory, 'replaced');
  await mkdir(target);
  await writeFile(join(target, 'old.txt'), 'old');
  await new Promise<void>((resolve, reject) => {
    const writer = fstream.Writer({ path: target, type: 'File' });
    writer.once('error', reject);
    writer.once('close', resolve);
    writer.end('replacement');
  });
  expect(await readFile(target, 'utf8')).toBe('replacement');
});
