import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
if (existsSync('.env')) {
  console.log('.env already exists; left unchanged.');
  process.exit(0);
}
const password = randomBytes(24).toString('hex');
let text = readFileSync('.env.example', 'utf8').replaceAll('CHANGE_ME', password);
text = text.replace('REPLACE_WITH_64_HEX_CHARACTERS', randomBytes(32).toString('hex'));
text = text.replaceAll(
  'REPLACE_WITH_AT_LEAST_32_RANDOM_BYTES',
  randomBytes(48).toString('base64url'),
);
writeFileSync('.env', text, { mode: 0o600 });
console.log('Generated .env with random development secrets.');
