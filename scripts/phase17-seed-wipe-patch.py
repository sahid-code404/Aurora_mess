from pathlib import Path

path = Path("scripts/seed.ts")
text = path.read_text()
old = '''  const tables = [
    "policyExemption", "passwordResetToken", "idempotencyRecord", "deletionRequest", "outboxEvent",
    "notification", "announcement", "taskSubmissionItem", "taskSubmission", "taskItem", "task",
    "billAdjustment", "billLine", "bill", "billingSnapshot", "billingPeriod",
    "formulaVersion", "formulaDefinition",
    "ledgerEntry", "ledgerJournal", "ledgerAccount",
    "refund", "paymentStatusHistory", "payment", "expenseItem", "expense", "expenseCategory",
    "guestMealRequest", "residentMeal", "mealInstance", "mealDefinitionVersion", "mealDefinition",
    "leaveRequest", "calendarEvent", "storedFile",
    "userPolicyAcceptance", "userStatusHistory", "session", "userProfile", "user",
    "policyVersion", "policy", "institutionSecuritySettings", "institutionSettings", "institution",
  ];'''
new = '''  const tables = [
    // Operational/security records without children.
    "rateLimitBucket", "policyExemption", "passwordResetToken", "idempotencyRecord", "deletionRequest", "outboxEvent", "auditEvent",
    "notification", "announcement",

    // Tasks and generated expense links.
    "taskSubmissionItem", "taskSubmission", "taskItem", "task",

    // Frozen billing artifacts: children before parents.
    "billAdjustment", "billLine", "bill", "billingSnapshot", "billingPeriod",

    // Formula/rule/variable version graphs.
    "formulaDependency", "formulaVersion", "formulaDefinition",
    "ruleVersion", "ruleDefinition",
    "customVariableValue", "variableDefinition",

    // Ledger + financial records.
    "ledgerEntry", "ledgerJournal", "ledgerAccount",
    "refund", "paymentStatusHistory", "payment", "expenseItem", "expense", "expenseCategory",

    // Meal-scoped join rows use RESTRICT on MealDefinition and must be removed
    // before definitions. Leave/calendar parents can then be removed safely.
    "leaveRequestMeal", "calendarEventMeal",
    "guestMealRequest", "residentMeal", "mealInstance", "mealDefinitionVersion",
    "leaveRequest", "calendarEvent", "mealDefinition",
    "storedFile",

    // User-owned records before users. User holds the FK to UserProfile, so
    // users must be deleted before profiles for repeatable seeding.
    "userPolicyAcceptance", "userStatusHistory", "session", "user",
    "userProfile",
    "policyVersion", "policy",
    "institutionSecuritySettings", "institutionSettings", "institution",
  ];'''

if new in text:
    print("Phase 17 seed cleanup already patched")
elif old not in text:
    raise SystemExit("expected seed wipe table block not found")
else:
    path.write_text(text.replace(old, new, 1))
    print("Phase 17 seed cleanup patched")
