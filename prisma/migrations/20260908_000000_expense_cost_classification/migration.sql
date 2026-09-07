-- First-class expense billing classification.
-- MEAL_COST participates in the per-meal charge pool.
-- EXTRA_COST remains a real approved expense/cash outflow but is excluded from
-- meal-charge allocation unless an admin explicitly references it in a formula.

ALTER TABLE "Expense"
ADD COLUMN "costClass" TEXT NOT NULL DEFAULT 'EXTRA_COST';

-- Preserve historical billing semantics deterministically. Existing official
-- market/food/fuel categories were the old meal-expense heuristic, and approved
-- MARKET_PURCHASE task expenses were always meal purchases.
UPDATE "Expense" AS e
SET "costClass" = 'MEAL_COST'
FROM "ExpenseCategory" AS c
WHERE e."categoryId" = c."id"
  AND UPPER(TRIM(c."name")) IN ('MARKET', 'GROCERY', 'VEGETABLES', 'MESS', 'FOOD', 'FUEL', 'GAS');

UPDATE "Expense"
SET "costClass" = 'MEAL_COST'
WHERE "source" = 'TASK';

ALTER TABLE "Expense"
ADD CONSTRAINT "Expense_costClass_check"
CHECK ("costClass" IN ('MEAL_COST', 'EXTRA_COST'));

CREATE INDEX "Expense_institutionId_status_date_costClass_idx"
ON "Expense"("institutionId", "status", "date", "costClass");
