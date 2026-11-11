ALTER TABLE "Account"
  ADD COLUMN "category" TEXT NOT NULL DEFAULT 'OTHER',
  ADD COLUMN "parentId" UUID;

ALTER TABLE "Account"
  ADD CONSTRAINT "Account_parentId_fkey"
  FOREIGN KEY ("parentId") REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "Account"
  ADD CONSTRAINT "Account_parent_not_self" CHECK ("parentId" IS NULL OR "parentId" <> "id"),
  ADD CONSTRAINT "Account_category_check" CHECK ("category" IN (
    'SALES', 'PURCHASE', 'EXPENSE', 'INDIRECT_EXPENSE', 'CAPITAL',
    'SUPPLIER', 'CUSTOMER', 'ASSET', 'LIABILITY', 'OTHER'
  ));

CREATE INDEX "Account_projectId_category_idx" ON "Account"("projectId", "category");
CREATE INDEX "Account_parentId_idx" ON "Account"("parentId");

UPDATE "Account" SET "category" = CASE
  WHEN "type" = 'ASSET' THEN 'ASSET'
  WHEN "type" = 'LIABILITY' THEN 'LIABILITY'
  WHEN "type" = 'EQUITY' THEN 'CAPITAL'
  WHEN "type" = 'REVENUE' THEN 'SALES'
  WHEN "type" = 'EXPENSE' THEN 'EXPENSE'
  ELSE 'OTHER'
END;

CREATE TABLE "SupplierPayment" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "projectId" UUID NOT NULL,
  "vendorId" UUID NOT NULL,
  "purchaseId" UUID,
  "paymentAccountId" UUID NOT NULL,
  "reference" TEXT NOT NULL,
  "amount" DECIMAL(18,2) NOT NULL,
  "paidAt" TIMESTAMP(3) NOT NULL,
  "method" TEXT NOT NULL,
  "transactionReference" TEXT,
  "notes" TEXT NOT NULL DEFAULT '',
  "status" TEXT NOT NULL DEFAULT 'POSTED',
  "journalId" UUID NOT NULL,
  "reversalId" UUID,
  "createdBy" UUID NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "SupplierPayment_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "SupplierPayment_amount_positive" CHECK ("amount" > 0),
  CONSTRAINT "SupplierPayment_status_check" CHECK ("status" IN ('POSTED', 'REVERSED'))
);

CREATE UNIQUE INDEX "SupplierPayment_reference_key" ON "SupplierPayment"("reference");
CREATE UNIQUE INDEX "SupplierPayment_journalId_key" ON "SupplierPayment"("journalId");
CREATE UNIQUE INDEX "SupplierPayment_reversalId_key" ON "SupplierPayment"("reversalId");
CREATE INDEX "SupplierPayment_projectId_paidAt_idx" ON "SupplierPayment"("projectId", "paidAt");
CREATE INDEX "SupplierPayment_vendorId_purchaseId_idx" ON "SupplierPayment"("vendorId", "purchaseId");

CREATE TABLE "Expense" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "projectId" UUID NOT NULL,
  "purchaseId" UUID,
  "unitId" UUID,
  "vendorId" UUID,
  "expenseAccountId" UUID NOT NULL,
  "paymentAccountId" UUID NOT NULL,
  "reference" TEXT NOT NULL,
  "category" TEXT NOT NULL,
  "treatment" TEXT NOT NULL DEFAULT 'OPERATING',
  "description" TEXT NOT NULL,
  "amount" DECIMAL(18,2) NOT NULL,
  "incurredAt" TIMESTAMP(3) NOT NULL,
  "method" TEXT NOT NULL,
  "transactionReference" TEXT,
  "status" TEXT NOT NULL DEFAULT 'POSTED',
  "journalId" UUID NOT NULL,
  "reversalId" UUID,
  "createdBy" UUID NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "Expense_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "Expense_amount_positive" CHECK ("amount" > 0),
  CONSTRAINT "Expense_treatment_check" CHECK ("treatment" IN ('OPERATING', 'CAPITALIZED')),
  CONSTRAINT "Expense_status_check" CHECK ("status" IN ('POSTED', 'REVERSED'))
);

CREATE UNIQUE INDEX "Expense_reference_key" ON "Expense"("reference");
CREATE UNIQUE INDEX "Expense_journalId_key" ON "Expense"("journalId");
CREATE UNIQUE INDEX "Expense_reversalId_key" ON "Expense"("reversalId");
CREATE INDEX "Expense_projectId_incurredAt_idx" ON "Expense"("projectId", "incurredAt");
CREATE INDEX "Expense_unitId_idx" ON "Expense"("unitId");
CREATE INDEX "Expense_purchaseId_idx" ON "Expense"("purchaseId");
CREATE INDEX "Expense_expenseAccountId_idx" ON "Expense"("expenseAccountId");

CREATE TABLE "Partner" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "projectId" UUID NOT NULL,
  "name" TEXT NOT NULL,
  "phone" TEXT,
  "email" TEXT,
  "active" BOOLEAN NOT NULL DEFAULT true,
  "capitalAccountId" UUID NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "Partner_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Partner_capitalAccountId_key" ON "Partner"("capitalAccountId");
CREATE UNIQUE INDEX "Partner_projectId_name_key" ON "Partner"("projectId", "name");
CREATE INDEX "Partner_projectId_active_idx" ON "Partner"("projectId", "active");

CREATE TABLE "CapitalTransaction" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "projectId" UUID NOT NULL,
  "partnerId" UUID NOT NULL,
  "cashAccountId" UUID NOT NULL,
  "reference" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "amount" DECIMAL(18,2) NOT NULL,
  "transactedAt" TIMESTAMP(3) NOT NULL,
  "description" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'POSTED',
  "journalId" UUID NOT NULL,
  "reversalId" UUID,
  "createdBy" UUID NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "CapitalTransaction_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "CapitalTransaction_amount_positive" CHECK ("amount" > 0),
  CONSTRAINT "CapitalTransaction_kind_check" CHECK ("kind" IN ('CONTRIBUTION', 'WITHDRAWAL')),
  CONSTRAINT "CapitalTransaction_status_check" CHECK ("status" IN ('POSTED', 'REVERSED'))
);

CREATE UNIQUE INDEX "CapitalTransaction_reference_key" ON "CapitalTransaction"("reference");
CREATE UNIQUE INDEX "CapitalTransaction_journalId_key" ON "CapitalTransaction"("journalId");
CREATE UNIQUE INDEX "CapitalTransaction_reversalId_key" ON "CapitalTransaction"("reversalId");
CREATE INDEX "CapitalTransaction_projectId_transactedAt_idx" ON "CapitalTransaction"("projectId", "transactedAt");
CREATE INDEX "CapitalTransaction_partnerId_transactedAt_idx" ON "CapitalTransaction"("partnerId", "transactedAt");

ALTER TABLE "SupplierPayment" ADD CONSTRAINT "SupplierPayment_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "SupplierPayment" ADD CONSTRAINT "SupplierPayment_vendorId_fkey" FOREIGN KEY ("vendorId") REFERENCES "Vendor"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "SupplierPayment" ADD CONSTRAINT "SupplierPayment_purchaseId_fkey" FOREIGN KEY ("purchaseId") REFERENCES "PropertyPurchase"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "SupplierPayment" ADD CONSTRAINT "SupplierPayment_paymentAccountId_fkey" FOREIGN KEY ("paymentAccountId") REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "SupplierPayment" ADD CONSTRAINT "SupplierPayment_journalId_fkey" FOREIGN KEY ("journalId") REFERENCES "Journal"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "SupplierPayment" ADD CONSTRAINT "SupplierPayment_reversalId_fkey" FOREIGN KEY ("reversalId") REFERENCES "Journal"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "Expense" ADD CONSTRAINT "Expense_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Expense" ADD CONSTRAINT "Expense_purchaseId_fkey" FOREIGN KEY ("purchaseId") REFERENCES "PropertyPurchase"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Expense" ADD CONSTRAINT "Expense_unitId_fkey" FOREIGN KEY ("unitId") REFERENCES "Unit"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Expense" ADD CONSTRAINT "Expense_vendorId_fkey" FOREIGN KEY ("vendorId") REFERENCES "Vendor"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Expense" ADD CONSTRAINT "Expense_expenseAccountId_fkey" FOREIGN KEY ("expenseAccountId") REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Expense" ADD CONSTRAINT "Expense_paymentAccountId_fkey" FOREIGN KEY ("paymentAccountId") REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Expense" ADD CONSTRAINT "Expense_journalId_fkey" FOREIGN KEY ("journalId") REFERENCES "Journal"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Expense" ADD CONSTRAINT "Expense_reversalId_fkey" FOREIGN KEY ("reversalId") REFERENCES "Journal"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "Partner" ADD CONSTRAINT "Partner_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "Partner" ADD CONSTRAINT "Partner_capitalAccountId_fkey" FOREIGN KEY ("capitalAccountId") REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "CapitalTransaction" ADD CONSTRAINT "CapitalTransaction_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CapitalTransaction" ADD CONSTRAINT "CapitalTransaction_partnerId_fkey" FOREIGN KEY ("partnerId") REFERENCES "Partner"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CapitalTransaction" ADD CONSTRAINT "CapitalTransaction_cashAccountId_fkey" FOREIGN KEY ("cashAccountId") REFERENCES "Account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CapitalTransaction" ADD CONSTRAINT "CapitalTransaction_journalId_fkey" FOREIGN KEY ("journalId") REFERENCES "Journal"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CapitalTransaction" ADD CONSTRAINT "CapitalTransaction_reversalId_fkey" FOREIGN KEY ("reversalId") REFERENCES "Journal"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
