ALTER TABLE "Project" ADD COLUMN "photoIds" UUID[] NOT NULL DEFAULT ARRAY[]::UUID[];
ALTER TABLE "Unit" ADD COLUMN "photoIds" UUID[] NOT NULL DEFAULT ARRAY[]::UUID[];

UPDATE "Project" SET "photoIds" = ARRAY["photoId"] WHERE "photoId" IS NOT NULL;
UPDATE "Unit" SET "photoIds" = ARRAY["photoId"] WHERE "photoId" IS NOT NULL;

ALTER TABLE "Project" ADD CONSTRAINT "Project_photoIds_limit"
  CHECK (cardinality("photoIds") <= 5 AND array_position("photoIds", NULL) IS NULL);
ALTER TABLE "Unit" ADD CONSTRAINT "Unit_photoIds_limit"
  CHECK (cardinality("photoIds") <= 5 AND array_position("photoIds", NULL) IS NULL);
