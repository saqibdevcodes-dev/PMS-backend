// Prisma's runtime DMMF omits cardinality metadata. Read it from the schema instead.
import { readFile, writeFile } from 'node:fs/promises';
import { URL } from 'node:url';
const schema = await readFile(new URL('../prisma/schema.prisma', import.meta.url), 'utf8');
const blocks = [...schema.matchAll(/^(model|enum)\s+(\w+)\s*\{([\s\S]*?)^\}/gm)];
const modelNames = new Set(blocks.filter((b) => b[1] === 'model').map((b) => b[2]));
const enumNames = new Set(blocks.filter((b) => b[1] === 'enum').map((b) => b[2]));
const models = blocks
  .filter((b) => b[1] === 'model')
  .map((b) => ({
    name: b[2],
    fields: b[3].split('\n').flatMap((line) => {
      const field = line.trim().match(/^(\w+)\s+(\w+)(\[\]|\?)?(?:\s|$)/);
      if (!field || line.includes('@ignore')) return [];
      const [, name, type, suffix] = field;
      return [
        {
          name,
          type,
          kind: modelNames.has(type) ? 'object' : enumNames.has(type) ? 'enum' : 'scalar',
          isList: suffix === '[]',
          isRequired: suffix !== '?',
        },
      ];
    }),
  }));
const enums = blocks
  .filter((b) => b[1] === 'enum')
  .map((b) => ({
    name: b[2],
    values: b[3].split('\n').flatMap((line) => {
      const value = line.trim().match(/^(\w+)(?:\s|$)/);
      return value ? [{ name: value[1] }] : [];
    }),
  }));
await writeFile(
  new URL('../src/docs/models.json', import.meta.url),
  JSON.stringify({ models, enums }, null, 2) + '\n',
);
