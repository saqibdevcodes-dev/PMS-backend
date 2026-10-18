import { z } from 'zod';
import { DateTime } from 'luxon';
import { requireState } from '../../common/errors.js';

const confirmed = z
  .boolean()
  .refine((value) => value, 'Complete this verification before continuing.');
const common = {
  authorityName: z.string().trim().min(2).max(200),
  documentsReference: z.string().trim().min(3).max(1000),
  identityVerified: confirmed,
  ownershipVerified: confirmed,
  documentsVerified: confirmed,
  taxesAndFeesVerified: confirmed,
  clearanceStatus: z.enum(['VERIFIED', 'NOT_REQUIRED']),
  clearanceReference: z.string().trim().max(300).optional(),
  clearanceValidUntil: z.iso.date().optional(),
  clearanceReason: z.string().trim().max(1000).optional(),
};
const clearanceChecks = (value: z.infer<ReturnType<typeof base>>, ctx: z.RefinementCtx) => {
  if (value.clearanceStatus === 'VERIFIED' && !value.clearanceReference?.trim())
    ctx.addIssue({
      code: 'custom',
      path: ['clearanceReference'],
      message: 'Enter the authority NDC / NOC or dues-clearance reference.',
    });
  if (
    value.clearanceStatus === 'NOT_REQUIRED' &&
    (!value.clearanceReason || value.clearanceReason.length < 3)
  )
    ctx.addIssue({
      code: 'custom',
      path: ['clearanceReason'],
      message: 'Record why this authority does not require a separate clearance document.',
    });
  if (
    value.clearanceStatus === 'VERIFIED' &&
    value.clearanceValidUntil &&
    value.clearanceValidUntil < DateTime.now().setZone('Asia/Karachi').toISODate()!
  )
    ctx.addIssue({
      code: 'custom',
      path: ['clearanceValidUntil'],
      message: 'The authority clearance has expired. Verify a current document.',
    });
};
function base() {
  return z.object(common).strict();
}
export const transferVerification = base()
  .extend({ consentVerified: confirmed })
  .superRefine(clearanceChecks);
export const possessionVerification = base()
  .extend({ possessionReleased: confirmed, sitePlanVerified: confirmed })
  .superRefine(clearanceChecks);
export type TransferVerification = z.infer<typeof transferVerification>;
export type PossessionVerification = z.infer<typeof possessionVerification>;
export const handoverAcknowledgement = z
  .object({
    handoverReference: z.string().trim().min(3).max(300),
    receivedByName: z.string().trim().min(2).max(200),
  })
  .strict();
export function verificationRecord(
  checks: TransferVerification | PossessionVerification,
  ownerIds: string[],
  actorId: string,
) {
  return {
    ...checks,
    checkedOwnerIds: ownerIds,
    verifiedBy: actorId,
    verifiedAt: new Date().toISOString(),
  };
}
export function verifyStored(kind: 'transfer' | 'possession', value: unknown, owners: string[]) {
  requireState(
    !!value && typeof value === 'object' && !Array.isArray(value),
    'VERIFICATION_REQUIRED',
    'Review the case documents before completing this request.',
    422,
  );
  const {
    checkedOwnerIds,
    verifiedBy: _by,
    verifiedAt: _at,
    ...checks
  } = value as Record<string, unknown>;
  const parsed = (kind === 'transfer' ? transferVerification : possessionVerification).safeParse(
    checks,
  );
  requireState(
    parsed.success,
    'VERIFICATION_REQUIRED',
    parsed.error?.issues[0]?.message ?? 'Review the case documents.',
    422,
  );
  requireState(
    Array.isArray(checkedOwnerIds) &&
      checkedOwnerIds.length === owners.length &&
      owners.every((id) => checkedOwnerIds.includes(id)),
    'OWNERS_CHANGED',
    'Ownership has changed. Review the case documents for the current owner.',
    409,
  );
}
