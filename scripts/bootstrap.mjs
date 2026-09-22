import { readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
const path = '.env';
let content = readFileSync(path, 'utf8');
if (!/^ADMIN_EMAIL=.+/m.test(content)) content += '\nADMIN_EMAIL=admin@pms.local\n';
if (!/^ADMIN_PASSWORD=.+/m.test(content))
  content += 'ADMIN_PASSWORD=' + randomBytes(24).toString('base64url') + 'Aa1!\n';
if (!/^S3_PUBLIC_ENDPOINT=/m.test(content)) content += 'S3_PUBLIC_ENDPOINT=http://localhost:9002\n';
writeFileSync(path, content, { mode: 0o600 });
console.log(
  'Local administrator credentials are configured in the ignored .env file. No credentials printed.',
);
