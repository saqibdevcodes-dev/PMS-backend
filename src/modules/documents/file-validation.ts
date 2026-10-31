import { fileTypeFromBuffer } from 'file-type';
import { extname } from 'node:path';
import { requireState } from '../../common/errors.js';

const types: Record<string, string> = {
  '.pdf': 'application/pdf',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.doc': 'application/msword',
};

export async function documentMime(name: string, bytes: Buffer) {
  const extension = extname(name).toLowerCase();
  const expected = types[extension];
  const detected = await fileTypeFromBuffer(bytes).catch(() => undefined);
  const legacyWord =
    extension === '.doc' &&
    detected?.mime === 'application/x-cfb' &&
    bytes.includes(Buffer.from('WordDocument', 'utf16le'));
  requireState(
    expected && (detected?.mime === expected || legacyWord),
    'INVALID_FILE_TYPE',
    'The file content does not match its extension. Choose a valid PDF, Word document, PNG, JPEG or WebP file.',
    422,
  );
  return expected;
}
