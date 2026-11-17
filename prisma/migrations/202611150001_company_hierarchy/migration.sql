CREATE TYPE "CompanyMemberRole" AS ENUM ('OWNER', 'ADMIN', 'MEMBER');

CREATE TABLE "Company" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "logoId" UUID,
    "address" TEXT NOT NULL DEFAULT '',
    "phone" TEXT NOT NULL DEFAULT '',
    "email" TEXT NOT NULL DEFAULT '',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Company_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "CompanyMember" (
    "companyId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "role" "CompanyMemberRole" NOT NULL DEFAULT 'MEMBER',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "CompanyMember_pkey" PRIMARY KEY ("companyId", "userId")
);

ALTER TABLE "Project" ADD COLUMN "companyId" UUID;

CREATE UNIQUE INDEX "Company_code_key" ON "Company"("code");
CREATE INDEX "CompanyMember_userId_idx" ON "CompanyMember"("userId");
CREATE INDEX "Project_companyId_createdAt_idx" ON "Project"("companyId", "createdAt");

ALTER TABLE "Company"
  ADD CONSTRAINT "Company_logoId_fkey"
  FOREIGN KEY ("logoId") REFERENCES "ImageAsset"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CompanyMember"
  ADD CONSTRAINT "CompanyMember_companyId_fkey"
  FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "CompanyMember"
  ADD CONSTRAINT "CompanyMember_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "Project"
  ADD CONSTRAINT "Project_companyId_fkey"
  FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Preserve every existing installation by placing all current projects in one
-- company and copying the first available legacy project logo to that company.
WITH legacy_company AS (
  INSERT INTO "Company" ("code", "name", "logoId")
  SELECT
    'CMP-000001',
    'Main Company',
    (SELECT "logoId" FROM "Project" WHERE "logoId" IS NOT NULL ORDER BY "createdAt" LIMIT 1)
  WHERE EXISTS (SELECT 1 FROM "Project")
  RETURNING "id"
)
UPDATE "Project"
SET "companyId" = (SELECT "id" FROM legacy_company)
WHERE "companyId" IS NULL;

INSERT INTO "CompanyMember" ("companyId", "userId", "role")
SELECT DISTINCT p."companyId", access."userId", 'OWNER'::"CompanyMemberRole"
FROM "UserProjectAccess" access
JOIN "Project" p ON p."id" = access."projectId"
WHERE p."companyId" IS NOT NULL
ON CONFLICT ("companyId", "userId") DO NOTHING;
