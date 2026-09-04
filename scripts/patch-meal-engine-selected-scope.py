from pathlib import Path

path = Path("src/lib/domain/meal-engine.ts")
text = path.read_text()

replacements = []

replacements.append((
'''export function dayCoveredBy(day: Date, row: { startDate: Date; endDate: Date }): boolean {
  return utcDayFloor(row.startDate) <= day && utcDayFloor(row.endDate) >= day;
}
''',
'''export function dayCoveredBy(day: Date, row: { startDate: Date; endDate: Date }): boolean {
  return utcDayFloor(row.startDate) <= day && utcDayFloor(row.endDate) >= day;
}

export type MealScopedRow = {
  mealScope?: string | null;
  selectedMeals?: { mealDefinitionId: string }[];
};

/** ALL_MEALS is the backwards-compatible default; SELECTED_MEALS is explicit. */
export function scopedRowAffectsMeal(row: MealScopedRow, mealDefinitionId: string): boolean {
  if (row.mealScope !== "SELECTED_MEALS") return true;
  return (row.selectedMeals ?? []).some((selected) => selected.mealDefinitionId === mealDefinitionId);
}
'''))

replacements.append((
'''  instance: { serviceDate: Date; cutoffAt: Date };
''',
'''  instance: { serviceDate: Date; cutoffAt: Date; mealDefinitionId: string };
'''))

replacements.append((
'''    const events = await client.calendarEvent.findMany({
      where: {
        institutionId: inputs.institutionId,
        disableMeals: true,
        startDate: { lte: dayEnd },
        endDate: { gte: dayStart },
      },
    });
    calendarDisabled = (events as { startDate: Date; endDate: Date }[]).some((e) => dayCoveredBy(dayStart, e));
''',
'''    const events = await client.calendarEvent.findMany({
      where: {
        institutionId: inputs.institutionId,
        disableMeals: true,
        startDate: { lte: dayEnd },
        endDate: { gte: dayStart },
      },
      include: { selectedMeals: { select: { mealDefinitionId: true } } },
    });
    calendarDisabled = (events as ({ startDate: Date; endDate: Date } & MealScopedRow)[]).some(
      (e) => dayCoveredBy(dayStart, e) && scopedRowAffectsMeal(e, inputs.instance.mealDefinitionId)
    );
'''))

replacements.append((
'''    const leaves = await client.leaveRequest.findMany({
      where: {
        residentId: inputs.resident.id,
        status: "APPROVED",
        startDate: { lte: dayEnd },
        endDate: { gte: dayStart },
      },
    });
    onLeave = (leaves as { startDate: Date; endDate: Date }[]).some((l) => dayCoveredBy(dayStart, l));
''',
'''    const leaves = await client.leaveRequest.findMany({
      where: {
        residentId: inputs.resident.id,
        status: "APPROVED",
        startDate: { lte: dayEnd },
        endDate: { gte: dayStart },
      },
      include: { selectedMeals: { select: { mealDefinitionId: true } } },
    });
    onLeave = (leaves as ({ startDate: Date; endDate: Date } & MealScopedRow)[]).some(
      (l) => dayCoveredBy(dayStart, l) && scopedRowAffectsMeal(l, inputs.instance.mealDefinitionId)
    );
'''))

replacements.append((
'''  const disableEvents = (await client.calendarEvent.findMany({
    where: { institutionId, disableMeals: true, startDate: { lte: toMid }, endDate: { gte: fromMid } },
  })) as { startDate: Date; endDate: Date }[];
  const approvedLeaves = (await client.leaveRequest.findMany({
    where: { residentId, status: "APPROVED", startDate: { lte: toMid }, endDate: { gte: fromMid } },
  })) as { startDate: Date; endDate: Date }[];
''',
'''  const disableEvents = (await client.calendarEvent.findMany({
    where: { institutionId, disableMeals: true, startDate: { lte: toMid }, endDate: { gte: fromMid } },
    include: { selectedMeals: { select: { mealDefinitionId: true } } },
  })) as ({ startDate: Date; endDate: Date } & MealScopedRow)[];
  const approvedLeaves = (await client.leaveRequest.findMany({
    where: { residentId, status: "APPROVED", startDate: { lte: toMid }, endDate: { gte: fromMid } },
    include: { selectedMeals: { select: { mealDefinitionId: true } } },
  })) as ({ startDate: Date; endDate: Date } & MealScopedRow)[];
'''))

replacements.append((
'''      calendarDisabled: disableEvents.some((e) => dayCoveredBy(dayStart, e)),
      onLeave: approvedLeaves.some((l) => dayCoveredBy(dayStart, l)),
''',
'''      calendarDisabled: disableEvents.some(
        (e) => dayCoveredBy(dayStart, e) && scopedRowAffectsMeal(e, inst.mealDefinitionId)
      ),
      onLeave: approvedLeaves.some(
        (l) => dayCoveredBy(dayStart, l) && scopedRowAffectsMeal(l, inst.mealDefinitionId)
      ),
'''))

replacements.append((
'''  const disableEvents = (await client.calendarEvent.findMany({
    where: { institutionId, disableMeals: true, startDate: { lte: toMid }, endDate: { gte: fromMid } },
  })) as { startDate: Date; endDate: Date; createdAt: Date }[];
  const leaves = (await client.leaveRequest.findMany({
    where: { residentId: { in: residentIds }, status: "APPROVED", startDate: { lte: toMid }, endDate: { gte: fromMid } },
  })) as { residentId: string; startDate: Date; endDate: Date; reviewedAt: Date | null }[];
''',
'''  const disableEvents = (await client.calendarEvent.findMany({
    where: { institutionId, disableMeals: true, startDate: { lte: toMid }, endDate: { gte: fromMid } },
    include: { selectedMeals: { select: { mealDefinitionId: true } } },
  })) as ({ startDate: Date; endDate: Date; createdAt: Date } & MealScopedRow)[];
  const leaves = (await client.leaveRequest.findMany({
    where: { residentId: { in: residentIds }, status: "APPROVED", startDate: { lte: toMid }, endDate: { gte: fromMid } },
    include: { selectedMeals: { select: { mealDefinitionId: true } } },
  })) as ({ residentId: string; startDate: Date; endDate: Date; reviewedAt: Date | null } & MealScopedRow)[];
'''))

replacements.append((
'''      calendarDisabled: disableEvents.some(
        (e) => dayCoveredBy(dayStart, e) && e.createdAt.getTime() <= new Date(instRow.cutoffAt).getTime()
      ),
      onLeave: leaves.some(
        (l) =>
          l.residentId === rm.residentId &&
          dayCoveredBy(dayStart, l) &&
          l.reviewedAt != null &&
          l.reviewedAt.getTime() <= new Date(instRow.cutoffAt).getTime()
      ),
''',
'''      calendarDisabled: disableEvents.some(
        (e) =>
          dayCoveredBy(dayStart, e) &&
          scopedRowAffectsMeal(e, instRow.mealDefinitionId) &&
          e.createdAt.getTime() <= new Date(instRow.cutoffAt).getTime()
      ),
      onLeave: leaves.some(
        (l) =>
          l.residentId === rm.residentId &&
          dayCoveredBy(dayStart, l) &&
          scopedRowAffectsMeal(l, instRow.mealDefinitionId) &&
          l.reviewedAt != null &&
          l.reviewedAt.getTime() <= new Date(instRow.cutoffAt).getTime()
      ),
'''))

replacements.append((
'''  const disableEvents = (await client.calendarEvent.findMany({
    where: { institutionId, disableMeals: true, startDate: { lte: toMid }, endDate: { gte: fromMid } },
  })) as { startDate: Date; endDate: Date }[];
  const leaves = (await client.leaveRequest.findMany({
    where: { residentId: { in: residentIds }, status: "APPROVED", startDate: { lte: toMid }, endDate: { gte: fromMid } },
  })) as { residentId: string; startDate: Date; endDate: Date }[];
''',
'''  const disableEvents = (await client.calendarEvent.findMany({
    where: { institutionId, disableMeals: true, startDate: { lte: toMid }, endDate: { gte: fromMid } },
    include: { selectedMeals: { select: { mealDefinitionId: true } } },
  })) as ({ startDate: Date; endDate: Date } & MealScopedRow)[];
  const leaves = (await client.leaveRequest.findMany({
    where: { residentId: { in: residentIds }, status: "APPROVED", startDate: { lte: toMid }, endDate: { gte: fromMid } },
    include: { selectedMeals: { select: { mealDefinitionId: true } } },
  })) as ({ residentId: string; startDate: Date; endDate: Date } & MealScopedRow)[];
'''))

replacements.append((
'''      calendarDisabled: disableEvents.some((e) => dayCoveredBy(dayStart, e)),
      onLeave: leaves.some((l) => l.residentId === rm.residentId && dayCoveredBy(dayStart, l)),
''',
'''      calendarDisabled: disableEvents.some(
        (e) => dayCoveredBy(dayStart, e) && scopedRowAffectsMeal(e, instRow.mealDefinitionId)
      ),
      onLeave: leaves.some(
        (l) =>
          l.residentId === rm.residentId &&
          dayCoveredBy(dayStart, l) &&
          scopedRowAffectsMeal(l, instRow.mealDefinitionId)
      ),
'''))

for old, new in replacements:
    count = text.count(old)
    if count != 1:
        raise SystemExit(f"Expected exactly one match, got {count}: {old[:80]!r}")
    text = text.replace(old, new, 1)

path.write_text(text)
