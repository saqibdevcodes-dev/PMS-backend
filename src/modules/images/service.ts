import type { Tx } from '../../database/client.js';
import type { Context } from '../../common/context.js';
import { found, requireState } from '../../common/errors.js';
export const purposes = [
  'PROJECT',
  'UNIT',
  'FEATURE',
  'CUSTOMER',
  'DEALER',
  'USER',
  'PAYMENT',
] as const;
export type ImagePurpose = (typeof purposes)[number];
export const imageGrants: Record<ImagePurpose, { write: string[]; read: string[] }> = {
  PROJECT: { write: ['projects.create', 'projects.update'], read: ['projects.read'] },
  UNIT: { write: ['inventory.create', 'inventory.update'], read: ['inventory.read'] },
  FEATURE: { write: ['inventory.create', 'inventory.update'], read: ['inventory.read'] },
  CUSTOMER: { write: ['customers.create', 'customers.update'], read: ['customers.read'] },
  DEALER: { write: ['dealers.manage'], read: ['dealers.read'] },
  USER: { write: ['users.manage'], read: ['users.manage'] },
  PAYMENT: { write: ['payments.create'], read: ['payments.read'] },
};
export async function requireImage(
  tx: Tx,
  ctx: Context,
  imageId: string | null | undefined,
  purpose: ImagePurpose,
) {
  if (!imageId) return;
  const image = found(await tx.imageAsset.findUnique({ where: { id: imageId } }));
  const projectScoped = !['PROJECT', 'USER'].includes(purpose);
  requireState(
    image.purpose === purpose &&
      (projectScoped
        ? image.projectId === ctx.projectId
        : image.uploadedBy === ctx.actor.id ||
          (purpose === 'PROJECT' &&
            !!ctx.projectId &&
            !!(await tx.project.findFirst({
              where: {
                id: ctx.projectId,
                OR: [{ photoId: image.id }, { photoIds: { has: image.id } }],
              },
            })))),
    'IMAGE_SCOPE_MISMATCH',
    'Choose an image uploaded for this record and project.',
    422,
  );
}
type GalleryInput = { photoId?: string | null; photoIds?: string[] };
export async function requireGalleryImages(
  tx: Tx,
  ctx: Context,
  input: GalleryInput,
  purpose: 'PROJECT' | 'UNIT',
  current?: GalleryInput,
) {
  if (current && input.photoIds === undefined && input.photoId === undefined) return {};
  // Older clients can replace the cover without dropping the remaining gallery.
  const photoIds =
    input.photoIds ??
    (input.photoId
      ? [
          input.photoId,
          ...(current?.photoIds ?? []).filter(
            (imageId) => imageId !== current?.photoId && imageId !== input.photoId,
          ),
        ]
      : []);
  requireState(
    photoIds.length <= 5 && new Set(photoIds).size === photoIds.length,
    'INVALID_GALLERY',
    'Choose up to five different photos.',
    422,
  );
  const photoId = photoIds[0] ?? null;
  requireState(
    input.photoIds === undefined || input.photoId === undefined || input.photoId === photoId,
    'INVALID_GALLERY',
    'The cover photo must be the first gallery image.',
    422,
  );
  for (const imageId of photoIds) await requireImage(tx, ctx, imageId, purpose);
  return { photoIds, photoId };
}
export async function requireUnitImages(
  tx: Tx,
  ctx: Context,
  input: {
    photoId?: string | null;
    photoIds?: string[];
    features?: string[];
    featureImages?: { feature: string; imageId: string }[];
  },
  current?: GalleryInput,
) {
  const gallery = await requireGalleryImages(tx, ctx, input, 'UNIT', current);
  for (const item of input.featureImages ?? []) {
    requireState(
      input.features?.includes(item.feature),
      'FEATURE_IMAGE_MISMATCH',
      'Select the feature before adding its photo.',
      422,
    );
    await requireImage(tx, ctx, item.imageId, 'FEATURE');
  }
  return gallery;
}
