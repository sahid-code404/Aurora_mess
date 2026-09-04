from pathlib import Path

path = Path("prisma/schema.prisma")
text = path.read_text()

text = text.replace(
"""  versions  MealDefinitionVersion[]
  instances MealInstance[]

  @@unique([institutionId, name])
""",
"""  versions           MealDefinitionVersion[]
  instances          MealInstance[]
  leaveSelections    LeaveRequestMeal[]
  calendarSelections CalendarEventMeal[]

  @@unique([institutionId, name])
""",
1,
)

text = text.replace(
"""model LeaveRequest {
  id               String    @id @default(cuid())
  institutionId    String
  residentId       String
  startDate        DateTime
  endDate          DateTime
  reason           String
  status           String    @default(\"PENDING\") // PENDING | APPROVED | REJECTED | CANCELLED
  createdAt        DateTime  @default(now())
  reviewedAt       DateTime?
  reviewedByUserId String?
  reviewReason     String?

  @@index([institutionId, status])
  @@index([residentId, status])
}
""",
"""model LeaveRequest {
  id               String    @id @default(cuid())
  institutionId    String
  residentId       String
  startDate        DateTime
  endDate          DateTime
  reason           String
  mealScope        String    @default(\"ALL_MEALS\") // ALL_MEALS | SELECTED_MEALS
  status           String    @default(\"PENDING\") // PENDING | APPROVED | REJECTED | CANCELLED
  createdAt        DateTime  @default(now())
  reviewedAt       DateTime?
  reviewedByUserId String?
  reviewReason     String?

  selectedMeals LeaveRequestMeal[]

  @@index([institutionId, status])
  @@index([residentId, status])
}

model LeaveRequestMeal {
  id               String @id @default(cuid())
  leaveRequestId   String
  mealDefinitionId String

  leaveRequest   LeaveRequest   @relation(fields: [leaveRequestId], references: [id], onDelete: Cascade)
  mealDefinition MealDefinition @relation(fields: [mealDefinitionId], references: [id], onDelete: Restrict)

  @@unique([leaveRequestId, mealDefinitionId])
  @@index([mealDefinitionId])
}
""",
1,
)

text = text.replace(
"""model CalendarEvent {
  id              String   @id @default(cuid())
  institutionId   String
  name            String
  description     String?
  startDate       DateTime
  endDate         DateTime
  type            String   @default(\"HOLIDAY\") // HOLIDAY | FESTIVAL | MAINTENANCE | CUSTOM
  disableMeals    Boolean  @default(false)
  createdByUserId String?
  createdAt       DateTime @default(now())

  @@index([institutionId, startDate])
}
""",
"""model CalendarEvent {
  id              String   @id @default(cuid())
  institutionId   String
  name            String
  description     String?
  startDate       DateTime
  endDate         DateTime
  type            String   @default(\"HOLIDAY\") // HOLIDAY | FESTIVAL | MAINTENANCE | CUSTOM
  disableMeals    Boolean  @default(false)
  mealScope       String   @default(\"ALL_MEALS\") // ALL_MEALS | SELECTED_MEALS
  createdByUserId String?
  createdAt       DateTime @default(now())

  selectedMeals CalendarEventMeal[]

  @@index([institutionId, startDate])
}

model CalendarEventMeal {
  id               String @id @default(cuid())
  calendarEventId  String
  mealDefinitionId String

  calendarEvent  CalendarEvent  @relation(fields: [calendarEventId], references: [id], onDelete: Cascade)
  mealDefinition MealDefinition @relation(fields: [mealDefinitionId], references: [id], onDelete: Restrict)

  @@unique([calendarEventId, mealDefinitionId])
  @@index([mealDefinitionId])
}
""",
1,
)

if "model LeaveRequestMeal" not in text or "model CalendarEventMeal" not in text:
    raise SystemExit("Meal-scope schema patch did not apply")

path.write_text(text)
