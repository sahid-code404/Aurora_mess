-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateTable
CREATE TABLE "Institution" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "timezone" TEXT NOT NULL DEFAULT 'Asia/Kolkata',
    "currencyCode" TEXT NOT NULL DEFAULT 'INR',
    "currencyMinorDigits" INTEGER NOT NULL DEFAULT 2,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Institution_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InstitutionSettings" (
    "id" TEXT NOT NULL,
    "institutionId" TEXT NOT NULL,
    "deficitThresholdMinor" INTEGER NOT NULL DEFAULT 100000,
    "gracePeriodDays" INTEGER NOT NULL DEFAULT 7,
    "restrictMealsOnDeficit" BOOLEAN NOT NULL DEFAULT true,
    "deficitPolicyEnabled" BOOLEAN NOT NULL DEFAULT true,
    "billingDueDays" INTEGER NOT NULL DEFAULT 10,
    "guestMealPriceMinor" INTEGER NOT NULL DEFAULT 5500,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "InstitutionSettings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InstitutionSecuritySettings" (
    "id" TEXT NOT NULL,
    "institutionId" TEXT NOT NULL,
    "maxLoginAttempts" INTEGER NOT NULL DEFAULT 8,
    "loginWindowMinutes" INTEGER NOT NULL DEFAULT 15,
    "sessionIdleMinutes" INTEGER NOT NULL DEFAULT 43200,
    "sensitiveActionMinutes" INTEGER NOT NULL DEFAULT 15,
    "requireReasonOnOverride" BOOLEAN NOT NULL DEFAULT true,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "InstitutionSecuritySettings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Policy" (
    "id" TEXT NOT NULL,
    "institutionId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Policy_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PolicyVersion" (
    "id" TEXT NOT NULL,
    "policyId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "content" TEXT NOT NULL,
    "publishedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PolicyVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UserPolicyAcceptance" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "policyId" TEXT NOT NULL,
    "policyVersionId" TEXT NOT NULL,
    "acceptedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ip" TEXT,
    "userAgent" TEXT,

    CONSTRAINT "UserPolicyAcceptance_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "institutionId" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "membershipEffectiveFrom" TIMESTAMP(3),
    "membershipEffectiveUntil" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "userProfileId" TEXT,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UserProfile" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "fullName" TEXT NOT NULL,
    "phone" TEXT,
    "roomNumber" TEXT,
    "address" TEXT,
    "emergencyContact" TEXT,
    "avatarColor" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "UserProfile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UserStatusHistory" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "fromStatus" TEXT,
    "toStatus" TEXT NOT NULL,
    "changedByUserId" TEXT,
    "reason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UserStatusHistory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "institutionId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "ip" TEXT,
    "userAgent" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MealDefinition" (
    "id" TEXT NOT NULL,
    "institutionId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "icon" TEXT,
    "colorToken" TEXT,
    "mealType" TEXT NOT NULL DEFAULT 'REGULAR',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "defaultState" TEXT NOT NULL DEFAULT 'ON',
    "defaultVisible" BOOLEAN NOT NULL DEFAULT true,
    "pricingStrategy" TEXT NOT NULL DEFAULT 'FORMULA',
    "fixedPriceMinor" INTEGER,
    "scheduleStrategy" TEXT NOT NULL DEFAULT 'DAILY',
    "weekdaysCsv" TEXT,
    "specificDate" TIMESTAMP(3),
    "serviceStartLocal" TEXT NOT NULL DEFAULT '12:30',
    "serviceEndLocal" TEXT NOT NULL DEFAULT '14:00',
    "cutoffStrategy" TEXT NOT NULL DEFAULT 'SAME_DAY',
    "cutoffOffsetDays" INTEGER NOT NULL DEFAULT 0,
    "cutoffLocalTime" TEXT NOT NULL DEFAULT '09:00',
    "internalNotes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "archivedAt" TIMESTAMP(3),
    "deleteRequestedAt" TIMESTAMP(3),

    CONSTRAINT "MealDefinition_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MealDefinitionVersion" (
    "id" TEXT NOT NULL,
    "mealDefinitionId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "configSnapshotJson" TEXT NOT NULL,
    "createdByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MealDefinitionVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MealInstance" (
    "id" TEXT NOT NULL,
    "institutionId" TEXT NOT NULL,
    "mealDefinitionId" TEXT NOT NULL,
    "mealDefinitionVersionId" TEXT NOT NULL,
    "serviceDate" TIMESTAMP(3) NOT NULL,
    "serviceStartAt" TIMESTAMP(3) NOT NULL,
    "serviceEndAt" TIMESTAMP(3) NOT NULL,
    "cutoffAt" TIMESTAMP(3) NOT NULL,
    "lockAt" TIMESTAMP(3) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'SCHEDULED',
    "priceStrategySnapshot" TEXT NOT NULL DEFAULT 'FORMULA',
    "fixedPriceMinorSnapshot" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MealInstance_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ResidentMeal" (
    "id" TEXT NOT NULL,
    "institutionId" TEXT NOT NULL,
    "residentId" TEXT NOT NULL,
    "mealInstanceId" TEXT NOT NULL,
    "baselineState" TEXT NOT NULL,
    "residentSelectedState" TEXT,
    "policyState" TEXT,
    "leaveState" TEXT,
    "adminOverrideState" TEXT,
    "effectiveState" TEXT NOT NULL,
    "effectiveReason" TEXT NOT NULL,
    "lockedAt" TIMESTAMP(3),
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ResidentMeal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GuestMealRequest" (
    "id" TEXT NOT NULL,
    "institutionId" TEXT NOT NULL,
    "hostResidentId" TEXT NOT NULL,
    "mealInstanceId" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "unitPriceMinor" INTEGER NOT NULL,
    "totalPriceMinor" INTEGER NOT NULL,
    "note" TEXT,
    "status" TEXT NOT NULL DEFAULT 'REQUESTED',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lockedAt" TIMESTAMP(3),

    CONSTRAINT "GuestMealRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LeaveRequest" (
    "id" TEXT NOT NULL,
    "institutionId" TEXT NOT NULL,
    "residentId" TEXT NOT NULL,
    "startDate" TIMESTAMP(3) NOT NULL,
    "endDate" TIMESTAMP(3) NOT NULL,
    "reason" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reviewedAt" TIMESTAMP(3),
    "reviewedByUserId" TEXT,
    "reviewReason" TEXT,

    CONSTRAINT "LeaveRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CalendarEvent" (
    "id" TEXT NOT NULL,
    "institutionId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "startDate" TIMESTAMP(3) NOT NULL,
    "endDate" TIMESTAMP(3) NOT NULL,
    "type" TEXT NOT NULL DEFAULT 'HOLIDAY',
    "disableMeals" BOOLEAN NOT NULL DEFAULT false,
    "createdByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CalendarEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StoredFile" (
    "id" TEXT NOT NULL,
    "institutionId" TEXT NOT NULL,
    "objectKey" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "mimeType" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "sha256" TEXT NOT NULL,
    "uploadedByUserId" TEXT,
    "scanStatus" TEXT NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StoredFile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Payment" (
    "id" TEXT NOT NULL,
    "institutionId" TEXT NOT NULL,
    "displayNumber" TEXT NOT NULL,
    "residentId" TEXT NOT NULL,
    "amountMinor" INTEGER NOT NULL,
    "method" TEXT NOT NULL,
    "reference" TEXT,
    "notes" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "idempotencyKey" TEXT,
    "proofFileId" TEXT,
    "submittedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reviewedAt" TIMESTAMP(3),
    "reviewedByUserId" TEXT,
    "rejectionReason" TEXT,
    "approvedJournalId" TEXT,
    "voidJournalId" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Payment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PaymentStatusHistory" (
    "id" TEXT NOT NULL,
    "paymentId" TEXT NOT NULL,
    "fromStatus" TEXT,
    "toStatus" TEXT NOT NULL,
    "changedByUserId" TEXT,
    "reason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PaymentStatusHistory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Refund" (
    "id" TEXT NOT NULL,
    "institutionId" TEXT NOT NULL,
    "residentId" TEXT NOT NULL,
    "paymentId" TEXT,
    "amountMinor" INTEGER NOT NULL,
    "mode" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "destination" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "journalId" TEXT,
    "createdByUserId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "Refund_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExpenseCategory" (
    "id" TEXT NOT NULL,
    "institutionId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ExpenseCategory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Expense" (
    "id" TEXT NOT NULL,
    "institutionId" TEXT NOT NULL,
    "displayNumber" TEXT NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "categoryId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "source" TEXT NOT NULL DEFAULT 'DIRECT',
    "description" TEXT NOT NULL,
    "comment" TEXT,
    "submittedByUserId" TEXT NOT NULL,
    "approvedByUserId" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "totalMinor" INTEGER NOT NULL,
    "voidReason" TEXT,
    "sourceTaskSubmissionId" TEXT,
    "journalId" TEXT,
    "reversalJournalId" TEXT,
    "proofFileId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Expense_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExpenseItem" (
    "id" TEXT NOT NULL,
    "expenseId" TEXT NOT NULL,
    "itemName" TEXT NOT NULL,
    "quantity" DOUBLE PRECISION NOT NULL,
    "unit" TEXT NOT NULL DEFAULT 'unit',
    "unitPriceMinor" INTEGER NOT NULL,
    "lineTotalMinor" INTEGER NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "ExpenseItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LedgerAccount" (
    "id" TEXT NOT NULL,
    "institutionId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LedgerAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LedgerJournal" (
    "id" TEXT NOT NULL,
    "institutionId" TEXT NOT NULL,
    "refType" TEXT,
    "refId" TEXT,
    "description" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'POSTED',
    "createdByUserId" TEXT,
    "reversedByJournalId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LedgerJournal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LedgerEntry" (
    "id" TEXT NOT NULL,
    "journalId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "debitMinor" INTEGER NOT NULL DEFAULT 0,
    "creditMinor" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LedgerEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VariableDefinition" (
    "id" TEXT NOT NULL,
    "institutionId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "valueType" TEXT NOT NULL,
    "unit" TEXT NOT NULL,
    "scope" TEXT NOT NULL DEFAULT 'BILLING_PERIOD',
    "frequency" TEXT DEFAULT 'MONTHLY',
    "providerKey" TEXT,
    "isPinned" BOOLEAN NOT NULL DEFAULT false,
    "archivedAt" TIMESTAMP(3),
    "createdByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "VariableDefinition_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CustomVariableValue" (
    "id" TEXT NOT NULL,
    "variableDefinitionId" TEXT NOT NULL,
    "valueMinor" INTEGER,
    "valueNumber" DOUBLE PRECISION,
    "valueBoolean" BOOLEAN,
    "valueText" TEXT,
    "effectiveFrom" TIMESTAMP(3) NOT NULL,
    "effectiveUntil" TIMESTAMP(3),
    "billingPeriodKey" TEXT,
    "billingPeriodId" TEXT,
    "residentId" TEXT,
    "supersedesId" TEXT,
    "createdByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CustomVariableValue_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FormulaDefinition" (
    "id" TEXT NOT NULL,
    "institutionId" TEXT NOT NULL,
    "name" TEXT NOT NULL DEFAULT 'Meal Charge',
    "description" TEXT,
    "outputVariableKey" TEXT NOT NULL DEFAULT 'meal_charge',
    "scope" TEXT NOT NULL DEFAULT 'BILLING_PERIOD',
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "activeVersionId" TEXT,
    "archivedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FormulaDefinition_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FormulaVersion" (
    "id" TEXT NOT NULL,
    "formulaDefinitionId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "inputMode" TEXT NOT NULL DEFAULT 'FORMULA',
    "expressionSource" TEXT NOT NULL,
    "naturalSource" TEXT,
    "normalizedExpression" TEXT,
    "compiledAstJson" TEXT NOT NULL,
    "humanPreview" TEXT NOT NULL,
    "outputType" TEXT NOT NULL DEFAULT 'MONEY_PER_MEAL',
    "checksum" TEXT NOT NULL,
    "createdByUserId" TEXT,
    "reason" TEXT,
    "effectiveFrom" TIMESTAMP(3),
    "effectiveUntil" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "active" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FormulaVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FormulaDependency" (
    "id" TEXT NOT NULL,
    "formulaVersionId" TEXT NOT NULL,
    "variableKey" TEXT NOT NULL,
    "dependencyType" TEXT NOT NULL DEFAULT 'DIRECT',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FormulaDependency_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BillingPeriod" (
    "id" TEXT NOT NULL,
    "institutionId" TEXT NOT NULL,
    "year" INTEGER NOT NULL,
    "month" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "formulaVersionId" TEXT,
    "mealChargeMinorSnapshot" INTEGER,
    "guestPriceMinorSnapshot" INTEGER,
    "generationState" TEXT,
    "generationError" TEXT,
    "closedAt" TIMESTAMP(3),
    "billedAt" TIMESTAMP(3),
    "createdByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BillingPeriod_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BillingSnapshot" (
    "id" TEXT NOT NULL,
    "institutionId" TEXT NOT NULL,
    "billingPeriodId" TEXT NOT NULL,
    "payloadJson" TEXT NOT NULL,
    "checksum" TEXT NOT NULL,
    "residentCount" INTEGER NOT NULL,
    "residentMealCount" INTEGER NOT NULL,
    "guestMealCount" INTEGER NOT NULL,
    "eligibleExpensesMinor" INTEGER NOT NULL,
    "approvedPaymentsMinor" INTEGER NOT NULL,
    "mealChargeMinor" INTEGER NOT NULL,
    "createdByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BillingSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Bill" (
    "id" TEXT NOT NULL,
    "institutionId" TEXT NOT NULL,
    "residentId" TEXT NOT NULL,
    "billingPeriodId" TEXT NOT NULL,
    "snapshotId" TEXT NOT NULL,
    "billNumber" TEXT NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "residentMealCount" INTEGER NOT NULL DEFAULT 0,
    "guestMealCount" INTEGER NOT NULL DEFAULT 0,
    "mealChargeMinor" INTEGER NOT NULL DEFAULT 0,
    "guestChargeMinor" INTEGER NOT NULL DEFAULT 0,
    "subtotalMinor" INTEGER NOT NULL DEFAULT 0,
    "adjustmentsMinor" INTEGER NOT NULL DEFAULT 0,
    "paymentsMinor" INTEGER NOT NULL DEFAULT 0,
    "totalDueMinor" INTEGER NOT NULL DEFAULT 0,
    "dueDate" TIMESTAMP(3) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'GENERATED',
    "generatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Bill_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BillLine" (
    "id" TEXT NOT NULL,
    "billId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "quantity" DOUBLE PRECISION,
    "unitPriceMinor" INTEGER,
    "amountMinor" INTEGER NOT NULL,
    "detailJson" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "BillLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BillAdjustment" (
    "id" TEXT NOT NULL,
    "billId" TEXT NOT NULL,
    "amountMinor" INTEGER NOT NULL,
    "reason" TEXT NOT NULL,
    "createdByUserId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BillAdjustment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Task" (
    "id" TEXT NOT NULL,
    "institutionId" TEXT NOT NULL,
    "taskType" TEXT NOT NULL DEFAULT 'MARKET_PURCHASE',
    "description" TEXT NOT NULL,
    "assignedResidentId" TEXT NOT NULL,
    "assignedByUserId" TEXT NOT NULL,
    "dueDate" TIMESTAMP(3),
    "notes" TEXT,
    "estimatedAmountMinor" INTEGER,
    "status" TEXT NOT NULL DEFAULT 'ASSIGNED',
    "rejectionReason" TEXT,
    "adminReviewReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Task_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TaskItem" (
    "id" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "itemName" TEXT NOT NULL,
    "expectedQuantity" DOUBLE PRECISION,
    "unit" TEXT NOT NULL DEFAULT 'unit',
    "estimatedUnitPriceMinor" INTEGER,

    CONSTRAINT "TaskItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TaskSubmission" (
    "id" TEXT NOT NULL,
    "taskId" TEXT NOT NULL,
    "comment" TEXT,
    "claimedTotalMinor" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'SUBMITTED',
    "submittedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reviewedAt" TIMESTAMP(3),
    "reviewedByUserId" TEXT,
    "reviewReason" TEXT,
    "expenseId" TEXT,
    "proofFileId" TEXT,

    CONSTRAINT "TaskSubmission_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TaskSubmissionItem" (
    "id" TEXT NOT NULL,
    "taskSubmissionId" TEXT NOT NULL,
    "itemName" TEXT NOT NULL,
    "quantity" DOUBLE PRECISION NOT NULL,
    "unit" TEXT NOT NULL DEFAULT 'unit',
    "unitPriceMinor" INTEGER NOT NULL,
    "lineTotalMinor" INTEGER NOT NULL,

    CONSTRAINT "TaskSubmissionItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Announcement" (
    "id" TEXT NOT NULL,
    "institutionId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "type" TEXT NOT NULL DEFAULT 'INFO',
    "priority" TEXT NOT NULL DEFAULT 'NORMAL',
    "target" TEXT NOT NULL DEFAULT 'EVERYONE',
    "publishAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3),
    "pinned" BOOLEAN NOT NULL DEFAULT false,
    "createdByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Announcement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Notification" (
    "id" TEXT NOT NULL,
    "institutionId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "entityRef" TEXT,
    "readAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Notification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditEvent" (
    "id" TEXT NOT NULL,
    "institutionId" TEXT NOT NULL,
    "actorUserId" TEXT,
    "actorRole" TEXT,
    "action" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT,
    "requestId" TEXT,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reason" TEXT,
    "beforeSummary" TEXT,
    "afterSummary" TEXT,
    "metadataJson" TEXT,
    "ip" TEXT,
    "userAgent" TEXT,

    CONSTRAINT "AuditEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OutboxEvent" (
    "id" TEXT NOT NULL,
    "institutionId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "payloadJson" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMP(3),

    CONSTRAINT "OutboxEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IdempotencyRecord" (
    "id" TEXT NOT NULL,
    "institutionId" TEXT NOT NULL,
    "scope" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "responseJson" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "IdempotencyRecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DeletionRequest" (
    "id" TEXT NOT NULL,
    "institutionId" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "requestedByUserId" TEXT NOT NULL,
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "scheduledFor" TIMESTAMP(3),
    "reason" TEXT,
    "status" TEXT NOT NULL DEFAULT 'QUEUED',
    "blockedReason" TEXT,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "DeletionRequest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PolicyExemption" (
    "id" TEXT NOT NULL,
    "institutionId" TEXT NOT NULL,
    "residentId" TEXT NOT NULL,
    "policyType" TEXT NOT NULL DEFAULT 'DEFICIT_RESTRICTION',
    "reason" TEXT NOT NULL,
    "startsAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3),
    "approvedByUserId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PolicyExemption_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PasswordResetToken" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PasswordResetToken_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "InstitutionSettings_institutionId_key" ON "InstitutionSettings"("institutionId");

-- CreateIndex
CREATE UNIQUE INDEX "InstitutionSecuritySettings_institutionId_key" ON "InstitutionSecuritySettings"("institutionId");

-- CreateIndex
CREATE UNIQUE INDEX "Policy_institutionId_type_title_key" ON "Policy"("institutionId", "type", "title");

-- CreateIndex
CREATE UNIQUE INDEX "PolicyVersion_policyId_version_key" ON "PolicyVersion"("policyId", "version");

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "UserProfile_userId_key" ON "UserProfile"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "Session_tokenHash_key" ON "Session"("tokenHash");

-- CreateIndex
CREATE UNIQUE INDEX "MealDefinition_institutionId_name_key" ON "MealDefinition"("institutionId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "MealDefinitionVersion_mealDefinitionId_version_key" ON "MealDefinitionVersion"("mealDefinitionId", "version");

-- CreateIndex
CREATE INDEX "MealInstance_institutionId_serviceDate_status_idx" ON "MealInstance"("institutionId", "serviceDate", "status");

-- CreateIndex
CREATE UNIQUE INDEX "MealInstance_mealDefinitionId_serviceDate_key" ON "MealInstance"("mealDefinitionId", "serviceDate");

-- CreateIndex
CREATE INDEX "ResidentMeal_institutionId_residentId_idx" ON "ResidentMeal"("institutionId", "residentId");

-- CreateIndex
CREATE UNIQUE INDEX "ResidentMeal_residentId_mealInstanceId_key" ON "ResidentMeal"("residentId", "mealInstanceId");

-- CreateIndex
CREATE INDEX "GuestMealRequest_institutionId_hostResidentId_status_idx" ON "GuestMealRequest"("institutionId", "hostResidentId", "status");

-- CreateIndex
CREATE INDEX "LeaveRequest_institutionId_status_idx" ON "LeaveRequest"("institutionId", "status");

-- CreateIndex
CREATE INDEX "LeaveRequest_residentId_status_idx" ON "LeaveRequest"("residentId", "status");

-- CreateIndex
CREATE INDEX "CalendarEvent_institutionId_startDate_idx" ON "CalendarEvent"("institutionId", "startDate");

-- CreateIndex
CREATE UNIQUE INDEX "StoredFile_objectKey_key" ON "StoredFile"("objectKey");

-- CreateIndex
CREATE UNIQUE INDEX "Payment_displayNumber_key" ON "Payment"("displayNumber");

-- CreateIndex
CREATE UNIQUE INDEX "Payment_idempotencyKey_key" ON "Payment"("idempotencyKey");

-- CreateIndex
CREATE INDEX "Payment_institutionId_residentId_status_idx" ON "Payment"("institutionId", "residentId", "status");

-- CreateIndex
CREATE INDEX "Payment_institutionId_status_submittedAt_idx" ON "Payment"("institutionId", "status", "submittedAt");

-- CreateIndex
CREATE UNIQUE INDEX "ExpenseCategory_institutionId_name_key" ON "ExpenseCategory"("institutionId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "Expense_displayNumber_key" ON "Expense"("displayNumber");

-- CreateIndex
CREATE UNIQUE INDEX "Expense_sourceTaskSubmissionId_key" ON "Expense"("sourceTaskSubmissionId");

-- CreateIndex
CREATE INDEX "Expense_institutionId_status_date_idx" ON "Expense"("institutionId", "status", "date");

-- CreateIndex
CREATE UNIQUE INDEX "LedgerAccount_institutionId_code_key" ON "LedgerAccount"("institutionId", "code");

-- CreateIndex
CREATE INDEX "LedgerEntry_journalId_idx" ON "LedgerEntry"("journalId");

-- CreateIndex
CREATE INDEX "LedgerEntry_accountId_idx" ON "LedgerEntry"("accountId");

-- CreateIndex
CREATE UNIQUE INDEX "VariableDefinition_institutionId_key_key" ON "VariableDefinition"("institutionId", "key");

-- CreateIndex
CREATE UNIQUE INDEX "FormulaDefinition_institutionId_outputVariableKey_key" ON "FormulaDefinition"("institutionId", "outputVariableKey");

-- CreateIndex
CREATE UNIQUE INDEX "FormulaVersion_formulaDefinitionId_version_key" ON "FormulaVersion"("formulaDefinitionId", "version");

-- CreateIndex
CREATE UNIQUE INDEX "FormulaDependency_formulaVersionId_variableKey_key" ON "FormulaDependency"("formulaVersionId", "variableKey");

-- CreateIndex
CREATE UNIQUE INDEX "BillingPeriod_institutionId_year_month_key" ON "BillingPeriod"("institutionId", "year", "month");

-- CreateIndex
CREATE UNIQUE INDEX "BillingSnapshot_billingPeriodId_key" ON "BillingSnapshot"("billingPeriodId");

-- CreateIndex
CREATE UNIQUE INDEX "Bill_billNumber_key" ON "Bill"("billNumber");

-- CreateIndex
CREATE INDEX "Bill_institutionId_status_idx" ON "Bill"("institutionId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "Bill_residentId_billingPeriodId_key" ON "Bill"("residentId", "billingPeriodId");

-- CreateIndex
CREATE INDEX "Task_institutionId_assignedResidentId_status_idx" ON "Task"("institutionId", "assignedResidentId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "TaskSubmission_taskId_key" ON "TaskSubmission"("taskId");

-- CreateIndex
CREATE UNIQUE INDEX "TaskSubmission_expenseId_key" ON "TaskSubmission"("expenseId");

-- CreateIndex
CREATE INDEX "TaskSubmission_status_idx" ON "TaskSubmission"("status");

-- CreateIndex
CREATE INDEX "Announcement_institutionId_publishAt_idx" ON "Announcement"("institutionId", "publishAt");

-- CreateIndex
CREATE INDEX "Notification_userId_readAt_createdAt_idx" ON "Notification"("userId", "readAt", "createdAt");

-- CreateIndex
CREATE INDEX "AuditEvent_institutionId_entityType_entityId_occurredAt_idx" ON "AuditEvent"("institutionId", "entityType", "entityId", "occurredAt");

-- CreateIndex
CREATE INDEX "AuditEvent_institutionId_occurredAt_idx" ON "AuditEvent"("institutionId", "occurredAt");

-- CreateIndex
CREATE INDEX "OutboxEvent_status_createdAt_idx" ON "OutboxEvent"("status", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "IdempotencyRecord_institutionId_scope_key_key" ON "IdempotencyRecord"("institutionId", "scope", "key");

-- CreateIndex
CREATE INDEX "PolicyExemption_institutionId_residentId_policyType_idx" ON "PolicyExemption"("institutionId", "residentId", "policyType");

-- CreateIndex
CREATE UNIQUE INDEX "PasswordResetToken_tokenHash_key" ON "PasswordResetToken"("tokenHash");

-- AddForeignKey
ALTER TABLE "InstitutionSettings" ADD CONSTRAINT "InstitutionSettings_institutionId_fkey" FOREIGN KEY ("institutionId") REFERENCES "Institution"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InstitutionSecuritySettings" ADD CONSTRAINT "InstitutionSecuritySettings_institutionId_fkey" FOREIGN KEY ("institutionId") REFERENCES "Institution"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PolicyVersion" ADD CONSTRAINT "PolicyVersion_policyId_fkey" FOREIGN KEY ("policyId") REFERENCES "Policy"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserPolicyAcceptance" ADD CONSTRAINT "UserPolicyAcceptance_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserPolicyAcceptance" ADD CONSTRAINT "UserPolicyAcceptance_policyId_fkey" FOREIGN KEY ("policyId") REFERENCES "Policy"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserPolicyAcceptance" ADD CONSTRAINT "UserPolicyAcceptance_policyVersionId_fkey" FOREIGN KEY ("policyVersionId") REFERENCES "PolicyVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "User" ADD CONSTRAINT "User_userProfileId_fkey" FOREIGN KEY ("userProfileId") REFERENCES "UserProfile"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserStatusHistory" ADD CONSTRAINT "UserStatusHistory_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Session" ADD CONSTRAINT "Session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MealDefinitionVersion" ADD CONSTRAINT "MealDefinitionVersion_mealDefinitionId_fkey" FOREIGN KEY ("mealDefinitionId") REFERENCES "MealDefinition"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MealInstance" ADD CONSTRAINT "MealInstance_mealDefinitionId_fkey" FOREIGN KEY ("mealDefinitionId") REFERENCES "MealDefinition"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MealInstance" ADD CONSTRAINT "MealInstance_mealDefinitionVersionId_fkey" FOREIGN KEY ("mealDefinitionVersionId") REFERENCES "MealDefinitionVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ResidentMeal" ADD CONSTRAINT "ResidentMeal_mealInstanceId_fkey" FOREIGN KEY ("mealInstanceId") REFERENCES "MealInstance"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GuestMealRequest" ADD CONSTRAINT "GuestMealRequest_mealInstanceId_fkey" FOREIGN KEY ("mealInstanceId") REFERENCES "MealInstance"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentStatusHistory" ADD CONSTRAINT "PaymentStatusHistory_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "Payment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Refund" ADD CONSTRAINT "Refund_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "Payment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Expense" ADD CONSTRAINT "Expense_categoryId_fkey" FOREIGN KEY ("categoryId") REFERENCES "ExpenseCategory"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExpenseItem" ADD CONSTRAINT "ExpenseItem_expenseId_fkey" FOREIGN KEY ("expenseId") REFERENCES "Expense"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LedgerEntry" ADD CONSTRAINT "LedgerEntry_journalId_fkey" FOREIGN KEY ("journalId") REFERENCES "LedgerJournal"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LedgerEntry" ADD CONSTRAINT "LedgerEntry_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "LedgerAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CustomVariableValue" ADD CONSTRAINT "CustomVariableValue_variableDefinitionId_fkey" FOREIGN KEY ("variableDefinitionId") REFERENCES "VariableDefinition"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FormulaVersion" ADD CONSTRAINT "FormulaVersion_formulaDefinitionId_fkey" FOREIGN KEY ("formulaDefinitionId") REFERENCES "FormulaDefinition"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FormulaDependency" ADD CONSTRAINT "FormulaDependency_formulaVersionId_fkey" FOREIGN KEY ("formulaVersionId") REFERENCES "FormulaVersion"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BillingSnapshot" ADD CONSTRAINT "BillingSnapshot_billingPeriodId_fkey" FOREIGN KEY ("billingPeriodId") REFERENCES "BillingPeriod"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Bill" ADD CONSTRAINT "Bill_billingPeriodId_fkey" FOREIGN KEY ("billingPeriodId") REFERENCES "BillingPeriod"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BillLine" ADD CONSTRAINT "BillLine_billId_fkey" FOREIGN KEY ("billId") REFERENCES "Bill"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BillAdjustment" ADD CONSTRAINT "BillAdjustment_billId_fkey" FOREIGN KEY ("billId") REFERENCES "Bill"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaskItem" ADD CONSTRAINT "TaskItem_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaskSubmission" ADD CONSTRAINT "TaskSubmission_taskId_fkey" FOREIGN KEY ("taskId") REFERENCES "Task"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaskSubmissionItem" ADD CONSTRAINT "TaskSubmissionItem_taskSubmissionId_fkey" FOREIGN KEY ("taskSubmissionId") REFERENCES "TaskSubmission"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

