-- AlterTable
ALTER TABLE "JournalLine" ADD COLUMN     "vendorId" UUID;

-- AlterTable
ALTER TABLE "Notification" ADD COLUMN     "customerId" UUID,
ADD COLUMN     "recipient" TEXT,
ALTER COLUMN "userId" DROP NOT NULL;

-- AlterTable
ALTER TABLE "Payment" ADD COLUMN "payerId" UUID;
UPDATE "Payment" p SET "payerId" = COALESCE((SELECT o."customerId" FROM "BookingOwner" o WHERE o."bookingId"=p."bookingId" AND o."validFrom"<=p."paidAt" AND (o."validTo" IS NULL OR o."validTo">p."paidAt") ORDER BY o.share DESC LIMIT 1), b."customerId") FROM "Booking" b WHERE b.id=p."bookingId";
ALTER TABLE "Payment" ALTER COLUMN "payerId" SET NOT NULL;

-- AddForeignKey
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_payerId_fkey" FOREIGN KEY ("payerId") REFERENCES "Customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JournalLine" ADD CONSTRAINT "JournalLine_vendorId_fkey" FOREIGN KEY ("vendorId") REFERENCES "Vendor"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "Notification" ADD CONSTRAINT "Notification_one_recipient" CHECK (("userId" IS NOT NULL) <> ("customerId" IS NOT NULL));

CREATE FUNCTION pms_payer_vendor_scope() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE project_id uuid;
BEGIN
  IF TG_TABLE_NAME='Payment' THEN
    SELECT u."projectId" INTO project_id FROM "Booking" b JOIN "Unit" u ON u.id=b."unitId" WHERE b.id=NEW."bookingId";
    IF NOT EXISTS (SELECT 1 FROM "Customer" WHERE id=NEW."payerId" AND "projectId"=project_id) THEN RAISE EXCEPTION 'Payer project mismatch' USING ERRCODE='23514'; END IF;
  ELSIF NEW."vendorId" IS NOT NULL THEN
    SELECT "projectId" INTO project_id FROM "Journal" WHERE id=NEW."journalId";
    IF NOT EXISTS (SELECT 1 FROM "Vendor" WHERE id=NEW."vendorId" AND "projectId"=project_id) THEN RAISE EXCEPTION 'Vendor project mismatch' USING ERRCODE='23514'; END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER payment_payer_scope BEFORE INSERT OR UPDATE ON "Payment" FOR EACH ROW EXECUTE FUNCTION pms_payer_vendor_scope();
CREATE TRIGGER journal_vendor_scope BEFORE INSERT ON "JournalLine" FOR EACH ROW EXECUTE FUNCTION pms_payer_vendor_scope();
