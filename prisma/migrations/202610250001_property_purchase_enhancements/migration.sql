-- AlterTable
ALTER TABLE "PropertyPurchase"
  ADD COLUMN "unitId" UUID REFERENCES "Unit"("id") ON DELETE SET NULL,
  ADD COLUMN "dealerId" UUID REFERENCES "Dealer"("id") ON DELETE SET NULL,
  ADD COLUMN "expenseItems" JSONB NOT NULL DEFAULT '[]';

CREATE INDEX "PropertyPurchase_unitId_idx" ON "PropertyPurchase"("unitId");
CREATE INDEX "PropertyPurchase_dealerId_idx" ON "PropertyPurchase"("dealerId");
