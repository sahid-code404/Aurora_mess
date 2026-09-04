-- AlterTable
ALTER TABLE "CalendarEvent" ADD COLUMN     "mealScope" TEXT NOT NULL DEFAULT 'ALL_MEALS';

-- AlterTable
ALTER TABLE "LeaveRequest" ADD COLUMN     "mealScope" TEXT NOT NULL DEFAULT 'ALL_MEALS';

-- CreateTable
CREATE TABLE "LeaveRequestMeal" (
    "id" TEXT NOT NULL,
    "leaveRequestId" TEXT NOT NULL,
    "mealDefinitionId" TEXT NOT NULL,

    CONSTRAINT "LeaveRequestMeal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CalendarEventMeal" (
    "id" TEXT NOT NULL,
    "calendarEventId" TEXT NOT NULL,
    "mealDefinitionId" TEXT NOT NULL,

    CONSTRAINT "CalendarEventMeal_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "LeaveRequestMeal_mealDefinitionId_idx" ON "LeaveRequestMeal"("mealDefinitionId");

-- CreateIndex
CREATE UNIQUE INDEX "LeaveRequestMeal_leaveRequestId_mealDefinitionId_key" ON "LeaveRequestMeal"("leaveRequestId", "mealDefinitionId");

-- CreateIndex
CREATE INDEX "CalendarEventMeal_mealDefinitionId_idx" ON "CalendarEventMeal"("mealDefinitionId");

-- CreateIndex
CREATE UNIQUE INDEX "CalendarEventMeal_calendarEventId_mealDefinitionId_key" ON "CalendarEventMeal"("calendarEventId", "mealDefinitionId");

-- AddForeignKey
ALTER TABLE "LeaveRequestMeal" ADD CONSTRAINT "LeaveRequestMeal_leaveRequestId_fkey" FOREIGN KEY ("leaveRequestId") REFERENCES "LeaveRequest"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LeaveRequestMeal" ADD CONSTRAINT "LeaveRequestMeal_mealDefinitionId_fkey" FOREIGN KEY ("mealDefinitionId") REFERENCES "MealDefinition"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CalendarEventMeal" ADD CONSTRAINT "CalendarEventMeal_calendarEventId_fkey" FOREIGN KEY ("calendarEventId") REFERENCES "CalendarEvent"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CalendarEventMeal" ADD CONSTRAINT "CalendarEventMeal_mealDefinitionId_fkey" FOREIGN KEY ("mealDefinitionId") REFERENCES "MealDefinition"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

