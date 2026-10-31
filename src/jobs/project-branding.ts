import { db } from '../database/client.js';
import { readObject } from '../integrations/storage.js';
import { found } from '../common/errors.js';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

export type DocumentBranding = { name: string; logo?: Buffer | string; timezone?: string };

// Call only after authorising access to the project/document. Missing project artwork
// falls back to its name, not to another project's logo.
export async function projectBranding(projectId: string): Promise<DocumentBranding> {
  const project = found(
    await db.project.findUnique({
      where: { id: projectId },
      select: {
        name: true,
        timezone: true,
        logo: { select: { key: true, purpose: true, mime: true } },
      },
    }),
  );
  const identity = {
    name: project.name,
    ...(project.timezone ? { timezone: project.timezone } : {}),
  };
  if (project.logo) {
    if (
      project.logo.purpose === 'PROJECT_LOGO' &&
      ['image/png', 'image/jpeg'].includes(project.logo.mime)
    ) {
      try {
        return { ...identity, logo: await readObject(project.logo.key) };
      } catch {
        return identity;
      }
    }
    return identity;
  }
  const fallback = resolve('assets/statement-logo.png');
  return { ...identity, ...(existsSync(fallback) ? { logo: fallback } : {}) };
}

export function drawDocumentBrand(
  doc: PDFKit.PDFDocument,
  branding: DocumentBranding,
  x: number,
  y: number,
  width = 156,
  height = 49,
) {
  if (branding.logo) {
    try {
      doc.image(branding.logo, x, y, { fit: [width, height], valign: 'center' });
      return;
    } catch {
      /* A damaged logo must not prevent a financial document from printing. */
    }
  }
  doc
    .font('Helvetica-Bold')
    .fontSize(12)
    .fillColor('#203249')
    .text(branding.name, x, y, { width, height, ellipsis: true });
}
