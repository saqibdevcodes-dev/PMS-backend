ALTER TABLE "Journal" ADD COLUMN "createdTransaction" BIGINT NOT NULL DEFAULT txid_current();

CREATE FUNCTION pms_journal_insert_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE original_transaction bigint;
BEGIN
  SELECT "createdTransaction" INTO original_transaction FROM "Journal" WHERE id=NEW."journalId";
  IF original_transaction IS DISTINCT FROM txid_current() THEN
    RAISE EXCEPTION 'Lines cannot be appended to an already posted journal' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER journal_line_insert_guard BEFORE INSERT ON "JournalLine" FOR EACH ROW EXECUTE FUNCTION pms_journal_insert_guard();

CREATE FUNCTION pms_payment_immutable_fields() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Payment history cannot be deleted' USING ERRCODE='23514'; END IF;
  IF (NEW."bookingId",NEW."payerId",NEW.amount,NEW.method,NEW."paidAt",NEW."transactionReference",NEW."receivingAccountId",NEW."receivedBy")
    IS DISTINCT FROM (OLD."bookingId",OLD."payerId",OLD.amount,OLD.method,OLD."paidAt",OLD."transactionReference",OLD."receivingAccountId",OLD."receivedBy") THEN
    RAISE EXCEPTION 'Payment details are immutable; use a reversal' USING ERRCODE='23514';
  END IF;
  IF NEW.status<>OLD.status AND NOT ((OLD.status='PENDING' AND NEW.status IN ('CLEARED','REJECTED','BOUNCED')) OR (OLD.status='CLEARED' AND NEW.status='REVERSED')) THEN
    RAISE EXCEPTION 'Illegal payment status transition' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER payment_immutable_fields BEFORE UPDATE OR DELETE ON "Payment" FOR EACH ROW EXECUTE FUNCTION pms_payment_immutable_fields();
