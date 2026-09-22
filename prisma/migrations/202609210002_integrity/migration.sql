-- Inventory claims remain unique even when multiple API instances race.
CREATE UNIQUE INDEX "Reservation_one_active_per_unit" ON "Reservation" ("unitId") WHERE status = 'ACTIVE';
CREATE UNIQUE INDEX "Booking_one_active_per_unit" ON "Booking" ("unitId") WHERE status <> 'CANCELLED';
CREATE UNIQUE INDEX "Transfer_one_pending_per_booking" ON "Transfer" ("bookingId") WHERE status = 'PENDING';
CREATE UNIQUE INDEX "Possession_one_active_per_booking" ON "Possession" ("bookingId") WHERE status IN ('PENDING','COMPLETED');
ALTER TABLE "Unit" ADD CONSTRAINT "Unit_nonnegative_price" CHECK (price > 0 AND charges >= 0 AND size > 0);
ALTER TABLE "Booking" ADD CONSTRAINT "Booking_price_consistency" CHECK ("basePrice" > 0 AND charges >= 0 AND discount >= 0 AND total = "basePrice" + charges - discount AND total > 0 AND "downPayment" >= 0 AND "downPayment" <= total);
ALTER TABLE "Installment" ADD CONSTRAINT "Installment_positive_amount" CHECK (amount > 0);
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_positive_amount" CHECK (amount > 0);
ALTER TABLE "PaymentAllocation" ADD CONSTRAINT "Allocation_positive_amount" CHECK (amount > 0);
ALTER TABLE "Refund" ADD CONSTRAINT "Refund_positive_amount" CHECK (amount > 0);
ALTER TABLE "Cancellation" ADD CONSTRAINT "Cancellation_nonnegative" CHECK (deduction >= 0 AND refundable >= 0);
ALTER TABLE "BookingOwner" ADD CONSTRAINT "Owner_valid_share" CHECK (share > 0 AND share <= 100 AND ("validTo" IS NULL OR "validTo" >= "validFrom"));
ALTER TABLE "JournalLine" ADD CONSTRAINT "JournalLine_one_side" CHECK (debit >= 0 AND credit >= 0 AND ((debit > 0 AND credit = 0) OR (credit > 0 AND debit = 0)));
ALTER TABLE "AccountingPeriod" ADD CONSTRAINT "Period_dates" CHECK ("startDate" <= "endDate");
ALTER TABLE "Approval" ADD CONSTRAINT "Approval_has_levels" CHECK (cardinality(permissions) > 0);

CREATE FUNCTION pms_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Posted records and audit history are immutable' USING ERRCODE = '23514'; END $$;
CREATE TRIGGER journal_immutable BEFORE UPDATE OR DELETE ON "Journal" FOR EACH ROW EXECUTE FUNCTION pms_immutable();
CREATE TRIGGER journal_line_immutable BEFORE UPDATE OR DELETE ON "JournalLine" FOR EACH ROW EXECUTE FUNCTION pms_immutable();
CREATE TRIGGER audit_immutable BEFORE UPDATE OR DELETE ON "AuditLog" FOR EACH ROW EXECUTE FUNCTION pms_immutable();

CREATE FUNCTION pms_journal_balanced() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE journal_id uuid; total_debit numeric; total_credit numeric; line_count integer;
BEGIN
  IF TG_TABLE_NAME = 'Journal' THEN journal_id := NEW.id; ELSE journal_id := NEW."journalId"; END IF;
  SELECT COALESCE(SUM(debit),0), COALESCE(SUM(credit),0), COUNT(*) INTO total_debit,total_credit,line_count FROM "JournalLine" WHERE "journalId"=journal_id;
  IF line_count < 2 OR total_debit <= 0 OR total_debit <> total_credit THEN RAISE EXCEPTION 'Journal must balance at commit' USING ERRCODE='23514'; END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER journal_balance AFTER INSERT ON "Journal" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION pms_journal_balanced();
CREATE CONSTRAINT TRIGGER journal_line_balance AFTER INSERT ON "JournalLine" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION pms_journal_balanced();

CREATE FUNCTION pms_journal_period() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE p "AccountingPeriod";
BEGIN
  SELECT * INTO p FROM "AccountingPeriod" WHERE id=NEW."periodId" FOR UPDATE;
  IF p.locked OR p."projectId" <> NEW."projectId" OR NEW."postedAt"::date < p."startDate" OR NEW."postedAt"::date > p."endDate" THEN RAISE EXCEPTION 'Invalid or closed accounting period' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER journal_period BEFORE INSERT ON "Journal" FOR EACH ROW EXECUTE FUNCTION pms_journal_period();

CREATE FUNCTION pms_scope_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE p1 uuid; p2 uuid;
BEGIN
  IF TG_TABLE_NAME='Reservation' THEN
    SELECT "projectId" INTO p1 FROM "Unit" WHERE id=NEW."unitId";
    SELECT "projectId" INTO p2 FROM "Customer" WHERE id=NEW."customerId";
  ELSIF TG_TABLE_NAME='Booking' THEN
    SELECT "projectId" INTO p1 FROM "Unit" WHERE id=NEW."unitId";
    SELECT "projectId" INTO p2 FROM "Customer" WHERE id=NEW."customerId";
    IF NOT EXISTS (SELECT 1 FROM "Reservation" r WHERE r.id=NEW."reservationId" AND r."unitId"=NEW."unitId") THEN RAISE EXCEPTION 'Reservation does not match booking unit' USING ERRCODE='23514'; END IF;
    IF NOT EXISTS (SELECT 1 FROM "PaymentPlanVersion" v JOIN "PaymentPlan" p ON p.id=v."planId" WHERE v.id=NEW."planVersionId" AND p."projectId"=p1) THEN RAISE EXCEPTION 'Payment plan project mismatch' USING ERRCODE='23514'; END IF;
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
CREATE TRIGGER reservation_scope BEFORE INSERT OR UPDATE ON "Reservation" FOR EACH ROW EXECUTE FUNCTION pms_scope_guard();
CREATE TRIGGER booking_scope BEFORE INSERT OR UPDATE ON "Booking" FOR EACH ROW EXECUTE FUNCTION pms_scope_guard();
CREATE TRIGGER owner_scope BEFORE INSERT OR UPDATE ON "BookingOwner" FOR EACH ROW EXECUTE FUNCTION pms_scope_guard();
CREATE TRIGGER payment_scope BEFORE INSERT OR UPDATE ON "Payment" FOR EACH ROW EXECUTE FUNCTION pms_scope_guard();
CREATE TRIGGER allocation_scope BEFORE INSERT OR UPDATE ON "PaymentAllocation" FOR EACH ROW EXECUTE FUNCTION pms_scope_guard();
CREATE TRIGGER journal_line_scope BEFORE INSERT ON "JournalLine" FOR EACH ROW EXECUTE FUNCTION pms_scope_guard();

CREATE FUNCTION pms_allocation_limit() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE paid numeric; installment_amount numeric; allocated numeric; payment_amount numeric;
BEGIN
  SELECT amount INTO installment_amount FROM "Installment" WHERE id=NEW."installmentId" FOR UPDATE;
  SELECT COALESCE(SUM(amount),0) INTO paid FROM "PaymentAllocation" WHERE "installmentId"=NEW."installmentId" AND "reversedAt" IS NULL;
  SELECT amount INTO payment_amount FROM "Payment" WHERE id=NEW."paymentId" FOR UPDATE;
  SELECT COALESCE(SUM(amount),0) INTO allocated FROM "PaymentAllocation" WHERE "paymentId"=NEW."paymentId" AND "reversedAt" IS NULL;
  IF paid>installment_amount OR allocated>payment_amount THEN RAISE EXCEPTION 'Payment allocation exceeds its limit' USING ERRCODE='23514'; END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER allocation_limit AFTER INSERT OR UPDATE ON "PaymentAllocation" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION pms_allocation_limit();
