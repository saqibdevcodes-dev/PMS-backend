import { describe, it, expect, vi, beforeEach } from 'vitest';
import PDFDocument from 'pdfkit';
import { readFile } from 'node:fs/promises';

const { findProject, readObject } = vi.hoisted(() => ({
  findProject: vi.fn(),
  readObject: vi.fn(),
}));
vi.mock('../src/database/client.js', () => ({ db: { project: { findUnique: findProject } } }));
vi.mock('../src/integrations/storage.js', () => ({ readObject }));
import { projectBranding, drawDocumentBrand } from '../src/jobs/project-branding.js';

beforeEach(() => vi.resetAllMocks());
describe('project document branding', () => {
  it('reads only the selected project logo and safely handles missing artwork', async () => {
    findProject.mockResolvedValue({
      name: 'Garden Homes',
      logo: { key: 'images/garden.png', mime: 'image/png', purpose: 'PROJECT_LOGO' },
    });
    readObject.mockResolvedValue(Buffer.from('artwork'));
    expect(await projectBranding('garden')).toEqual({
      name: 'Garden Homes',
      logo: Buffer.from('artwork'),
    });
    expect(findProject).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'garden' } }));
    expect(readObject).toHaveBeenCalledWith('images/garden.png');
    readObject.mockRejectedValue(new Error('File missing'));
    expect(await projectBranding('garden')).toEqual({ name: 'Garden Homes' });
    findProject.mockResolvedValue({ name: 'Another project', logo: null });
    expect(await projectBranding('another')).toMatchObject({ name: 'Another project' });
    expect(readObject).toHaveBeenCalledTimes(2);
  });
  it('embeds PNG artwork in PDFs and prints the project name for invalid image data', async () => {
    const logo = await readFile('assets/statement-logo.png');
    const doc = new PDFDocument({ compress: false });
    const chunks: Buffer[] = [];
    const result = new Promise<Buffer>((resolve, reject) => {
      doc.on('data', (chunk) => chunks.push(chunk));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);
    });
    const image = vi.spyOn(doc, 'image');
    drawDocumentBrand(doc, { name: 'Garden Homes', logo }, 42, 42);
    expect(image).toHaveBeenCalledWith(logo, 42, 42, expect.objectContaining({ fit: [156, 49] }));
    drawDocumentBrand(doc, { name: 'Missing artwork', logo: Buffer.from('not an image') }, 42, 120);
    doc.end();
    const bytes = await result;
    expect(bytes.subarray(0, 4).toString()).toBe('%PDF');
    expect(bytes.toString('latin1')).toContain('/Subtype /Image');
    const text = [...bytes.toString('latin1').matchAll(/\[([^\]]+)\] TJ/g)]
      .flatMap((match) =>
        [...match[1]!.matchAll(/<([a-f0-9]+)>/g)].map((part) =>
          Buffer.from(part[1]!, 'hex').toString(),
        ),
      )
      .join('');
    expect(text).toContain('Missing artwork');
  });
});
