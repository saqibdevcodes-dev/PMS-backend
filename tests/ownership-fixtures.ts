export const commonChecks = {
  authorityName: 'Test housing society',
  documentsReference: 'CASE-100: identity, original allotment, application and fee receipts',
  identityVerified: true,
  ownershipVerified: true,
  documentsVerified: true,
  taxesAndFeesVerified: true,
  clearanceStatus: 'NOT_REQUIRED' as const,
  clearanceReason: 'Society confirmation REF-100: separate clearance certificate not required.',
};
export const transferChecks = { ...commonChecks, consentVerified: true };
export const possessionChecks = {
  ...commonChecks,
  possessionReleased: true,
  sitePlanVerified: true,
};
export const handoverReceipt = {
  handoverReference: 'HANDOVER-100 signed receipt',
  receivedByName: 'Test owner',
};
