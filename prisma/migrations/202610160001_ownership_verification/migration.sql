-- Keep existing NDC links and history; new requests use an authority-specific case checklist.
ALTER TABLE "Transfer" ALTER COLUMN "ndcId" DROP NOT NULL;
ALTER TABLE "Transfer" ADD COLUMN "verification" JSONB;
ALTER TABLE "Possession" ADD COLUMN "verification" JSONB,
  ADD COLUMN "handoverReference" TEXT,
  ADD COLUMN "receivedByName" TEXT;
