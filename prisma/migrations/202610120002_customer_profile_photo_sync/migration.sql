-- Reconcile photos changed in the portal before customer records were synced.
UPDATE "Customer" AS customer
SET "photoId" = account."photoId", "updatedAt" = CURRENT_TIMESTAMP
FROM "User" AS account
JOIN "ImageAsset" AS image ON image.id = account."photoId"
WHERE customer."portalUserId" = account.id
  AND account."accountType" = 'CUSTOMER'
  AND image.purpose IN ('USER', 'CUSTOMER')
  AND customer."photoId" IS DISTINCT FROM account."photoId";
