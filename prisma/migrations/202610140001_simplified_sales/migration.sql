-- Additive: retain every historical booking, hold, approval and financial record.
ALTER TABLE "Project" ADD COLUMN "location" TEXT NOT NULL DEFAULT '', ADD COLUMN "description" TEXT NOT NULL DEFAULT '', ADD COLUMN "features" TEXT[] DEFAULT ARRAY[]::TEXT[], ADD COLUMN "featureImages" JSONB NOT NULL DEFAULT '[]';
ALTER TABLE "Booking" ALTER COLUMN "reservationId" DROP NOT NULL, ALTER COLUMN "planVersionId" DROP NOT NULL, ADD COLUMN "paymentType" TEXT NOT NULL DEFAULT 'INSTALLMENTS', ADD COLUMN "paymentTerms" JSONB NOT NULL DEFAULT '{}';
-- Close only unfinished holds; never release a property with a current booking.
UPDATE "Reservation" SET "status" = 'CANCELLED' WHERE "status" = 'ACTIVE' AND NOT EXISTS (SELECT 1 FROM "Booking" b WHERE b."reservationId" = "Reservation"."id");
INSERT INTO "UnitHistory" ("id", "unitId", "status", "price", "charges", "reason", "actorId", "createdAt")
SELECT gen_random_uuid(), u."id", 'AVAILABLE', u."price", u."charges", 'Unfinished hold closed when holds were retired', r."createdBy", CURRENT_TIMESTAMP
FROM "Unit" u JOIN LATERAL (SELECT "createdBy" FROM "Reservation" WHERE "unitId" = u."id" ORDER BY "createdAt" DESC LIMIT 1) r ON true
WHERE u."status" = 'RESERVED' AND NOT EXISTS (SELECT 1 FROM "Booking" b WHERE b."unitId" = u."id" AND b."status" <> 'CANCELLED');
UPDATE "Unit" u SET "status" = 'AVAILABLE', "updatedAt" = CURRENT_TIMESTAMP WHERE u."status" = 'RESERVED' AND NOT EXISTS (SELECT 1 FROM "Booking" b WHERE b."unitId" = u."id" AND b."status" <> 'CANCELLED');

-- Optional legacy links still receive project consistency checks when present.
CREATE OR REPLACE FUNCTION pms_scope_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE p1 uuid; p2 uuid;
BEGIN
  IF TG_TABLE_NAME='Reservation' THEN
    SELECT "projectId" INTO p1 FROM "Unit" WHERE id=NEW."unitId";
    SELECT "projectId" INTO p2 FROM "Customer" WHERE id=NEW."customerId";
  ELSIF TG_TABLE_NAME='Booking' THEN
    SELECT "projectId" INTO p1 FROM "Unit" WHERE id=NEW."unitId";
    SELECT "projectId" INTO p2 FROM "Customer" WHERE id=NEW."customerId";
    IF NEW."reservationId" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "Reservation" r WHERE r.id=NEW."reservationId" AND r."unitId"=NEW."unitId") THEN RAISE EXCEPTION 'Reservation does not match booking unit' USING ERRCODE='23514'; END IF;
    IF NEW."planVersionId" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "PaymentPlanVersion" v JOIN "PaymentPlan" p ON p.id=v."planId" WHERE v.id=NEW."planVersionId" AND p."projectId"=p1) THEN RAISE EXCEPTION 'Payment plan project mismatch' USING ERRCODE='23514'; END IF;
  ELSIF TG_TABLE_NAME='BookingOwner' THEN
    SELECT u."projectId" INTO p1 FROM "Booking" b JOIN "Unit" u ON u.id=b."unitId" WHERE b.id=NEW."bookingId";
    SELECT "projectId" INTO p2 FROM "Customer" WHERE id=NEW."customerId";
  ELSIF TG_TABLE_NAME='Payment' THEN
    SELECT u."projectId" INTO p1 FROM "Booking" b JOIN "Unit" u ON u.id=b."unitId" WHERE b.id=NEW."bookingId";
    SELECT "projectId" INTO p2 FROM "Account" WHERE id=NEW."receivingAccountId";
  ELSIF TG_TABLE_NAME='JournalLine' THEN
    SELECT "projectId" INTO p1 FROM "Journal" WHERE id=NEW."journalId";
    SELECT "projectId" INTO p2 FROM "Account" WHERE id=NEW."accountId";
  ELSIF TG_TABLE_NAME='PaymentAllocation' THEN
    SELECT "bookingId" INTO p1 FROM "Payment" WHERE id=NEW."paymentId";
    SELECT "bookingId" INTO p2 FROM "Installment" WHERE id=NEW."installmentId";
  END IF;
  IF p1 IS DISTINCT FROM p2 THEN RAISE EXCEPTION 'Cross-project or cross-booking reference' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
