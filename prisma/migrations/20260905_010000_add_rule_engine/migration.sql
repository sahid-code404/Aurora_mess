-- CreateTable
CREATE TABLE "RuleDefinition" (
    "id" TEXT NOT NULL,
    "institutionId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "policyType" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RuleDefinition_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RuleVersion" (
    "id" TEXT NOT NULL,
    "ruleDefinitionId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "rulesJson" TEXT NOT NULL,
    "checksum" TEXT NOT NULL,
    "effectiveFrom" TIMESTAMP(3),
    "effectiveUntil" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "createdByUserId" TEXT,
    "reason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RuleVersion_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "RuleDefinition_institutionId_policyType_status_idx" ON "RuleDefinition"("institutionId", "policyType", "status");

-- CreateIndex
CREATE UNIQUE INDEX "RuleDefinition_institutionId_key_key" ON "RuleDefinition"("institutionId", "key");

-- CreateIndex
CREATE INDEX "RuleVersion_ruleDefinitionId_status_effectiveFrom_idx" ON "RuleVersion"("ruleDefinitionId", "status", "effectiveFrom");

-- CreateIndex
CREATE UNIQUE INDEX "RuleVersion_ruleDefinitionId_version_key" ON "RuleVersion"("ruleDefinitionId", "version");

-- AddForeignKey
ALTER TABLE "RuleVersion" ADD CONSTRAINT "RuleVersion_ruleDefinitionId_fkey" FOREIGN KEY ("ruleDefinitionId") REFERENCES "RuleDefinition"("id") ON DELETE CASCADE ON UPDATE CASCADE;

