import { z } from "zod";
import { db } from "@/lib/db";
import { ApiError, CODES } from "@/lib/errors";

export const mealScopeSchema = z.enum(["ALL_MEALS", "SELECTED_MEALS"]);
export type MealScope = z.infer<typeof mealScopeSchema>;

export const mealDefinitionIdsSchema = z
  .array(z.string().min(1).max(120))
  .max(24, "Select at most 24 meal definitions.")
  .optional();

export function normalizeMealDefinitionIds(ids: string[] | undefined): string[] {
  return [...new Set((ids ?? []).map((id) => id.trim()).filter(Boolean))];
}

export function validateMealScopeShape(scope: MealScope, ids: string[]): void {
  if (scope === "SELECTED_MEALS" && ids.length === 0) {
    throw new ApiError(
      CODES.VALIDATION_FAILED,
      "Choose at least one meal when using Selected Meals scope.",
      422
    );
  }
  if (scope === "ALL_MEALS" && ids.length > 0) {
    throw new ApiError(
      CODES.VALIDATION_FAILED,
      "Do not send selected meal IDs when scope is All Meals.",
      422
    );
  }
}

/**
 * Verify selected IDs are live resident meal definitions belonging to the same
 * institution. GUEST_ONLY definitions remain in the separate guest domain and
 * cannot be targeted by resident leave/calendar scope.
 */
export async function validateMealScopeSelection(input: {
  institutionId: string;
  mealScope: MealScope;
  mealDefinitionIds?: string[];
  client?: any;
}): Promise<{ ids: string[]; meals: { id: string; name: string }[] }> {
  const client = input.client ?? db;
  const ids = normalizeMealDefinitionIds(input.mealDefinitionIds);
  validateMealScopeShape(input.mealScope, ids);

  if (input.mealScope === "ALL_MEALS") return { ids: [], meals: [] };

  const meals = (await client.mealDefinition.findMany({
    where: {
      institutionId: input.institutionId,
      id: { in: ids },
      active: true,
      archivedAt: null,
      mealType: { not: "GUEST_ONLY" },
    },
    select: { id: true, name: true },
  })) as { id: string; name: string }[];

  if (meals.length !== ids.length) {
    throw new ApiError(
      CODES.VALIDATION_FAILED,
      "One or more selected meals are unavailable or do not belong to this institution.",
      422
    );
  }

  const byId = new Map<string, { id: string; name: string }>(
    meals.map((meal) => [meal.id, meal] as const)
  );
  return {
    ids,
    meals: ids.map((id) => byId.get(id)).filter((meal): meal is { id: string; name: string } => meal != null),
  };
}

export function mealInstanceScopeWhere(mealScope: MealScope | string | null | undefined, ids: string[]) {
  return mealScope === "SELECTED_MEALS" ? { mealDefinitionId: { in: ids } } : {};
}

export function serializeSelectedMeals(
  mealScope: string | null | undefined,
  selectedMeals: Array<{ mealDefinitionId: string; mealDefinition?: { id: string; name: string } | null }> = []
) {
  return {
    mealScope: mealScope === "SELECTED_MEALS" ? "SELECTED_MEALS" : "ALL_MEALS",
    selectedMeals:
      mealScope === "SELECTED_MEALS"
        ? selectedMeals.map((selection) => ({
            id: selection.mealDefinition?.id ?? selection.mealDefinitionId,
            name: selection.mealDefinition?.name ?? "Meal",
          }))
        : [],
  };
}
