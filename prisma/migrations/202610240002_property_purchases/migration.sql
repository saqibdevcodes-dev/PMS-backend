ALTER TABLE "Vendor" ADD COLUMN "category" TEXT NOT NULL DEFAULT 'SUPPLIER', ADD COLUMN "email" TEXT, ADD COLUMN "address" TEXT NOT NULL DEFAULT '';
ALTER TABLE "Vendor" ADD CONSTRAINT "Vendor_category_check" CHECK ("category" IN ('SELLER', 'SUPPLIER', 'CONTRACTOR', 'MULTI_ROLE'));
CREATE TABLE "PropertyPurchase" (
  "id" UUID PRIMARY KEY, "projectId" UUID NOT NULL REFERENCES "Project"("id") ON DELETE RESTRICT,
  "vendorId" UUID NOT NULL REFERENCES "Vendor"("id") ON DELETE RESTRICT,
  "reference" TEXT NOT NULL UNIQUE, "title" TEXT NOT NULL, "location" TEXT NOT NULL,
  "purchaseDate" DATE NOT NULL, "price" DECIMAL(18,2) NOT NULL,
  "taxes" DECIMAL(18,2) NOT NULL DEFAULT 0, "legalFees" DECIMAL(18,2) NOT NULL DEFAULT 0,
  "brokerage" DECIMAL(18,2) NOT NULL DEFAULT 0, "otherCosts" DECIMAL(18,2) NOT NULL DEFAULT 0,
  "total" DECIMAL(18,2) NOT NULL, "fileReference" TEXT NOT NULL, "notes" TEXT NOT NULL DEFAULT '',
  "status" TEXT NOT NULL DEFAULT 'DRAFT',
  "journalId" UUID UNIQUE REFERENCES "Journal"("id") ON DELETE RESTRICT,
  "reversalId" UUID UNIQUE REFERENCES "Journal"("id") ON DELETE RESTRICT,
  "createdBy" UUID NOT NULL, "postedBy" UUID, "postedAt" TIMESTAMP(3), "voidReason" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "PropertyPurchase_costs_check" CHECK ("price" > 0 AND "taxes" >= 0 AND "legalFees" >= 0 AND "brokerage" >= 0 AND "otherCosts" >= 0 AND "total" = "price" + "taxes" + "legalFees" + "brokerage" + "otherCosts"),
  CONSTRAINT "PropertyPurchase_status_check" CHECK ("status" IN ('DRAFT', 'POSTED', 'VOIDED')),
  CONSTRAINT "PropertyPurchase_posting_check" CHECK (("status" != 'POSTED' OR ("journalId" IS NOT NULL AND "postedBy" IS NOT NULL AND "postedAt" IS NOT NULL)) AND ("status" != 'VOIDED' OR "journalId" IS NULL OR "reversalId" IS NOT NULL)),
  UNIQUE ("projectId", "vendorId", "fileReference")
);
CREATE INDEX "PropertyPurchase_projectId_purchaseDate_idx" ON "PropertyPurchase"("projectId", "purchaseDate");
