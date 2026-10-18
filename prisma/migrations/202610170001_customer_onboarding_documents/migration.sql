ALTER TABLE "User" ADD COLUMN "credentialsIssuedAt" TIMESTAMP(3), ADD COLUMN "firstLoginAt" TIMESTAMP(3);
ALTER TABLE "Customer" ADD COLUMN "identityType" TEXT NOT NULL DEFAULT 'OTHER';
ALTER TABLE "Document" ADD COLUMN "allProjectCustomers" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "Document" ADD CONSTRAINT "global_document_has_no_private_owner"
CHECK (NOT "allProjectCustomers" OR ("customerId" IS NULL AND "bookingId" IS NULL));
