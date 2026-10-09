CREATE TYPE "AccountTypeScope" AS ENUM ('STAFF', 'CUSTOMER');
ALTER TABLE "User" ADD COLUMN "accountType" "AccountTypeScope" NOT NULL DEFAULT 'STAFF';
ALTER TABLE "Customer" ADD COLUMN "portalUserId" UUID;
ALTER TABLE "Customer" ADD CONSTRAINT "Customer_portalUserId_fkey" FOREIGN KEY ("portalUserId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX "Customer_portalUserId_idx" ON "Customer"("portalUserId");
ALTER TABLE "Document" ADD COLUMN "portalVisible" BOOLEAN NOT NULL DEFAULT false;
CREATE TABLE "CustomerInvitation" (
  "id" UUID NOT NULL,
  "customerId" UUID NOT NULL,
  "email" TEXT NOT NULL,
  "hash" TEXT NOT NULL,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "usedAt" TIMESTAMP(3),
  "revokedAt" TIMESTAMP(3),
  "createdBy" UUID NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "CustomerInvitation_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "CustomerInvitation_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "CustomerInvitation_hash_key" ON "CustomerInvitation"("hash");
CREATE INDEX "CustomerInvitation_customerId_createdAt_idx" ON "CustomerInvitation"("customerId", "createdAt");
INSERT INTO "Permission" ("key") VALUES ('customers.portal.manage') ON CONFLICT DO NOTHING;
INSERT INTO "RolePermission" ("roleId", "permissionKey")
SELECT "id", 'customers.portal.manage' FROM "Role" WHERE "name" = 'Super Admin'
ON CONFLICT DO NOTHING;
