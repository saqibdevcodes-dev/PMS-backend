ALTER TABLE "Unit" DROP CONSTRAINT IF EXISTS "Unit_photoIds_limit";

ALTER TABLE "Unit" ADD CONSTRAINT "Unit_photoIds_limit"
  CHECK (cardinality("photoIds") <= 20 AND array_position("photoIds", NULL) IS NULL);
