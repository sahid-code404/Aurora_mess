from pathlib import Path


def replace(path: str, old: str, new: str):
    p = Path(path)
    text = p.read_text()
    if old not in text:
        raise SystemExit(f"missing patch anchor in {path}: {old[:100]!r}")
    p.write_text(text.replace(old, new, 1))

# Resident shared types.
replace(
    "src/components/app/resident/_shared/types.ts",
    "/* ------------------------------ leave requests ---------------------------- */\n\nexport interface LeavePreview {",
    "/* ------------------------------ leave requests ---------------------------- */\n\nexport interface MealOptionDto {\n  id: string;\n  name: string;\n  icon: string | null;\n  colorToken: string | null;\n  mealType: string;\n}\n\nexport interface LeavePreview {",
)
replace(
    "src/components/app/resident/_shared/types.ts",
    "  reason: string;\n  status: \"PENDING\" | \"APPROVED\" | \"REJECTED\" | string;",
    "  reason: string;\n  mealScope: \"ALL_MEALS\" | \"SELECTED_MEALS\";\n  selectedMeals: { id: string; name: string }[];\n  status: \"PENDING\" | \"APPROVED\" | \"REJECTED\" | string;",
)

# Admin calendar response type.
replace(
    "src/components/app/admin/_shared/types.ts",
    "  disableMeals: boolean;\n  createdAt: string;\n}",
    "  disableMeals: boolean;\n  mealScope: \"ALL_MEALS\" | \"SELECTED_MEALS\";\n  selectedMeals: { id: string; name: string }[];\n  createdAt: string;\n}",
)

# Resident leave UI.
path = "src/components/app/resident/_shared/guest-leave-dialogs.tsx"
replace(
    path,
    "import type { GuestMealDto, LeavePreview, MealInstanceDto, MealsMeta } from \"./types\";",
    "import type { GuestMealDto, LeavePreview, MealInstanceDto, MealsMeta, MealOptionDto } from \"./types\";",
)
replace(
    path,
    "  const [submitting, setSubmitting] = useState(false);\n  const [error, setError] = useState<string | null>(null);\n  const previewTimer = useRef<number | null>(null);",
    "  const [submitting, setSubmitting] = useState(false);\n  const [error, setError] = useState<string | null>(null);\n  const [mealScope, setMealScope] = useState<\"ALL_MEALS\" | \"SELECTED_MEALS\">(\"ALL_MEALS\");\n  const [selectedMealIds, setSelectedMealIds] = useState<string[]>([]);\n  const previewTimer = useRef<number | null>(null);\n\n  const mealOptionsQuery = useEnvelopeQuery<MealOptionDto[]>(open ? \"/api/v1/meal-options\" : null);\n  const mealOptions = mealOptionsQuery.data?.data ?? [];",
)
replace(
    path,
    "      setReason(\"\");\n      setError(null);",
    "      setReason(\"\");\n      setMealScope(\"ALL_MEALS\");\n      setSelectedMealIds([]);\n      setError(null);",
)
replace(
    path,
    "  const reasonValid = reason.trim().length >= 3;\n  const datesValid = startDate <= endDate;",
    "  const reasonValid = reason.trim().length >= 3;\n  const datesValid = startDate <= endDate;\n  const selectionValid = mealScope === \"ALL_MEALS\" || selectedMealIds.length > 0;",
)
replace(
    path,
    "    if (!open || !datesValid || !reasonValid) {",
    "    if (!open || !datesValid || !reasonValid || !selectionValid) {",
)
replace(
    path,
    "          reason: reason.trim(),\n          preview: true,",
    "          reason: reason.trim(),\n          mealScope,\n          mealDefinitionIds: mealScope === \"SELECTED_MEALS\" ? selectedMealIds : [],\n          preview: true,",
)
replace(
    path,
    "  }, [open, startDate, endDate, reason, datesValid, reasonValid]);",
    "  }, [open, startDate, endDate, reason, datesValid, reasonValid, selectionValid, mealScope, selectedMealIds]);",
)
replace(
    path,
    "        reason: reason.trim(),\n      });",
    "        reason: reason.trim(),\n        mealScope,\n        mealDefinitionIds: mealScope === \"SELECTED_MEALS\" ? selectedMealIds : [],\n      });",
)
replace(
    path,
    "            disabled={!datesValid || !reasonValid || submitting}",
    "            disabled={!datesValid || !reasonValid || !selectionValid || submitting}",
)
replace(
    path,
    "        <GlassField\n          label=\"Reason\"",
    "        <GlassField label=\"Meals during leave\" hint=\"Choose whether leave applies to every regular meal or only specific meals.\">\n          <div className=\"space-y-2.5\">\n            <div className=\"grid grid-cols-2 gap-2\">\n              <button\n                type=\"button\"\n                onClick={() => { setMealScope(\"ALL_MEALS\"); setSelectedMealIds([]); }}\n                className={cn(\n                  \"glass-inset min-h-11 rounded-md px-3 text-sm font-medium transition-all\",\n                  mealScope === \"ALL_MEALS\" ? \"ring-2 ring-ring text-foreground\" : \"text-muted-foreground hover:text-foreground\"\n                )}\n              >\n                All meals\n              </button>\n              <button\n                type=\"button\"\n                onClick={() => setMealScope(\"SELECTED_MEALS\")}\n                className={cn(\n                  \"glass-inset min-h-11 rounded-md px-3 text-sm font-medium transition-all\",\n                  mealScope === \"SELECTED_MEALS\" ? \"ring-2 ring-ring text-foreground\" : \"text-muted-foreground hover:text-foreground\"\n                )}\n              >\n                Selected meals\n              </button>\n            </div>\n\n            {mealScope === \"SELECTED_MEALS\" && (\n              <div className=\"glass-inset rounded-md p-2\">\n                {mealOptionsQuery.isPending ? (\n                  <InlinePreviewSkeleton />\n                ) : mealOptions.length === 0 ? (\n                  <p className=\"px-2 py-1 text-xs text-muted-foreground\">No selectable meals are configured.</p>\n                ) : (\n                  <div className=\"grid gap-1 sm:grid-cols-2\">\n                    {mealOptions.map((meal) => {\n                      const checked = selectedMealIds.includes(meal.id);\n                      return (\n                        <button\n                          key={meal.id}\n                          type=\"button\"\n                          aria-pressed={checked}\n                          onClick={() =>\n                            setSelectedMealIds((current) =>\n                              current.includes(meal.id) ? current.filter((id) => id !== meal.id) : [...current, meal.id]\n                            )\n                          }\n                          className={cn(\n                            \"flex min-h-10 items-center justify-between rounded-md px-3 text-left text-sm transition-colors\",\n                            checked ? \"bg-primary/12 font-medium text-primary\" : \"hover:bg-foreground/5\"\n                          )}\n                        >\n                          <span className=\"truncate\">{meal.name}</span>\n                          <span className={cn(\"ml-2 text-xs\", checked ? \"text-primary\" : \"text-muted-foreground\")}>\n                            {checked ? \"Selected\" : \"Add\"}\n                          </span>\n                        </button>\n                      );\n                    })}\n                  </div>\n                )}\n              </div>\n            )}\n          </div>\n        </GlassField>\n\n        <GlassField\n          label=\"Reason\"",
)
replace(
    path,
    "            {!datesValid || !reasonValid ? (\n              <p className=\"py-1.5 text-xs text-muted-foreground\">\n                Write a short reason to see how many meals will be affected.\n              </p>",
    "            {!datesValid || !reasonValid || !selectionValid ? (\n              <p className=\"py-1.5 text-xs text-muted-foreground\">\n                {!selectionValid ? \"Select at least one meal to preview this leave.\" : \"Write a short reason to see how many meals will be affected.\"}\n              </p>",
)

# Admin calendar UI and leave display contract.
path = "src/components/app/admin/calendar.tsx"
replace(
    path,
    "import type { CalendarEventRow } from \"./_shared/types\";",
    "import type { CalendarEventRow, MealDefinitionRow } from \"./_shared/types\";",
)
replace(
    path,
    "  status: \"PENDING\" | \"APPROVED\" | \"REJECTED\" | \"CANCELLED\";\n  futureUnlockedMeals: number;\n  alreadyLockedMeals: number;\n  createdAt: string;",
    "  status: \"PENDING\" | \"APPROVED\" | \"REJECTED\" | \"CANCELLED\";\n  mealScope: \"ALL_MEALS\" | \"SELECTED_MEALS\";\n  selectedMeals: { id: string; name: string }[];\n  preview: { futureUnlockedMeals: number; alreadyLockedMeals: number };\n  createdAt: string;",
)
replace(
    path,
    "                            {e.disableMeals && <Chip tone=\"danger\">Meals disabled</Chip>}",
    "                            {e.disableMeals && <Chip tone=\"danger\">Meals disabled</Chip>}\n                            {e.disableMeals && e.mealScope === \"SELECTED_MEALS\" && e.selectedMeals.length > 0 && (\n                              <Chip tone=\"neutral\">{e.selectedMeals.map((meal) => meal.name).join(\", \")}</Chip>\n                            )}",
)
replace(
    path,
    "                      {leave.futureUnlockedMeals > 0 && (\n                        <span className=\"text-muted-foreground\">\n                          ({leave.futureUnlockedMeals} unlocked meals)\n                        </span>\n                      )}",
    "                      {leave.preview.futureUnlockedMeals > 0 && (\n                        <span className=\"text-muted-foreground\">\n                          ({leave.preview.futureUnlockedMeals} unlocked meals)\n                        </span>\n                      )}",
)
replace(
    path,
    "                    {leave.reason && (\n                      <p className=\"mt-1 text-xs text-muted-foreground italic\">",
    "                    {leave.mealScope === \"SELECTED_MEALS\" && leave.selectedMeals.length > 0 && (\n                      <p className=\"mt-1 text-[11px] font-medium text-muted-foreground\">\n                        Applies to: {leave.selectedMeals.map((meal) => meal.name).join(\", \")}\n                      </p>\n                    )}\n                    {leave.reason && (\n                      <p className=\"mt-1 text-xs text-muted-foreground italic\">",
)
replace(
    path,
    "                Future unlocked meals in this window will automatically be marked On Leave and excluded from billing.",
    "                {approveTarget.mealScope === \"SELECTED_MEALS\"\n                  ? `Only ${approveTarget.selectedMeals.map((meal) => meal.name).join(\", \")} will be marked On Leave; other meals stay normal.`\n                  : \"Future unlocked meals in this window will automatically be marked On Leave and excluded from billing.\"}",
)
replace(
    path,
    "  const [disableMeals, setDisableMeals] = useState(false);\n  const [impact, setImpact] = useState<ImpactData | null>(null);",
    "  const [disableMeals, setDisableMeals] = useState(false);\n  const [mealScope, setMealScope] = useState<\"ALL_MEALS\" | \"SELECTED_MEALS\">(\"ALL_MEALS\");\n  const [selectedMealIds, setSelectedMealIds] = useState<string[]>([]);\n  const { data: mealDefinitions } = useApiQuery<MealDefinitionRow[]>(\"/api/v1/admin/meal-definitions\");\n  const mealOptions = (mealDefinitions ?? []).filter(\n    (meal) => meal.active && meal.archivedAt == null && meal.mealType !== \"GUEST_ONLY\" && meal.defaultVisible\n  );\n  const impactScopeKey = [...selectedMealIds].sort().join(\",\");\n  const [impact, setImpact] = useState<ImpactData | null>(null);",
)
replace(
    path,
    "        const res = await postJson<ImpactData>(`${CAL_ADMIN_PATH}/impact`, { startDate, endDate });",
    "        const res = await postJson<ImpactData>(`${CAL_ADMIN_PATH}/impact`, {\n          startDate,\n          endDate,\n          disableMeals: true,\n          mealScope,\n          mealDefinitionIds: mealScope === \"SELECTED_MEALS\" ? selectedMealIds : [],\n        });",
)
replace(
    path,
    "  }, [disableMeals, datesValid, startDate, endDate]);\n\n  const valid = name.trim().length >= 2 && datesValid;",
    "  }, [disableMeals, datesValid, startDate, endDate, mealScope, impactScopeKey]);\n\n  const scopeValid = !disableMeals || mealScope === \"ALL_MEALS\" || selectedMealIds.length > 0;\n  const valid = name.trim().length >= 2 && datesValid && scopeValid;",
)
replace(
    path,
    "        type,\n        disableMeals,\n      });",
    "        type,\n        disableMeals,\n        mealScope: disableMeals ? mealScope : \"ALL_MEALS\",\n        mealDefinitionIds: disableMeals && mealScope === \"SELECTED_MEALS\" ? selectedMealIds : [],\n      });",
)
replace(
    path,
    "      setDisableMeals(false);\n      setImpact(null);",
    "      setDisableMeals(false);\n      setMealScope(\"ALL_MEALS\");\n      setSelectedMealIds([]);\n      setImpact(null);",
)
replace(
    path,
    "            <p className=\"text-[11px] text-muted-foreground\">Marks every meal in the window as not available.</p>",
    "            <p className=\"text-[11px] text-muted-foreground\">Disable every meal or only selected meal types in this window.</p>",
)
replace(
    path,
    "        </div>\n\n        {/* impact preview */}\n        {disableMeals && datesValid && (",
    "        </div>\n\n        {disableMeals && (\n          <div className=\"space-y-2.5\">\n            <div className=\"grid grid-cols-2 gap-2\">\n              <button\n                type=\"button\"\n                onClick={() => { setMealScope(\"ALL_MEALS\"); setSelectedMealIds([]); }}\n                className={cn(\n                  \"glass-inset min-h-10 rounded-md px-3 text-sm font-medium transition-all\",\n                  mealScope === \"ALL_MEALS\" ? \"ring-2 ring-ring\" : \"text-muted-foreground hover:text-foreground\"\n                )}\n              >\n                All meals\n              </button>\n              <button\n                type=\"button\"\n                onClick={() => setMealScope(\"SELECTED_MEALS\")}\n                className={cn(\n                  \"glass-inset min-h-10 rounded-md px-3 text-sm font-medium transition-all\",\n                  mealScope === \"SELECTED_MEALS\" ? \"ring-2 ring-ring\" : \"text-muted-foreground hover:text-foreground\"\n                )}\n              >\n                Selected meals\n              </button>\n            </div>\n            {mealScope === \"SELECTED_MEALS\" && (\n              <div className=\"glass-inset grid gap-1 rounded-md p-2 sm:grid-cols-2\">\n                {mealOptions.length === 0 ? (\n                  <p className=\"px-2 py-1 text-xs text-muted-foreground sm:col-span-2\">No selectable meals are configured.</p>\n                ) : (\n                  mealOptions.map((meal) => {\n                    const checked = selectedMealIds.includes(meal.id);\n                    return (\n                      <button\n                        key={meal.id}\n                        type=\"button\"\n                        aria-pressed={checked}\n                        onClick={() =>\n                          setSelectedMealIds((current) =>\n                            current.includes(meal.id) ? current.filter((id) => id !== meal.id) : [...current, meal.id]\n                          )\n                        }\n                        className={cn(\n                          \"flex min-h-9 items-center justify-between rounded-md px-3 text-left text-sm transition-colors\",\n                          checked ? \"bg-primary/12 font-medium text-primary\" : \"hover:bg-foreground/5\"\n                        )}\n                      >\n                        <span className=\"truncate\">{meal.name}</span>\n                        <span className=\"ml-2 text-[11px]\">{checked ? \"Selected\" : \"Add\"}</span>\n                      </button>\n                    );\n                  })\n                )}\n              </div>\n            )}\n          </div>\n        )}\n\n        {/* impact preview */}\n        {disableMeals && datesValid && scopeValid && (",
)
