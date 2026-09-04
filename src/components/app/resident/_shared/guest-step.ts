"use client";

/**
 * Shared guest-meal stepper logic (meals page + dashboard) — the day's
 * "Guest meals" row adjusts the host's own guest requests directly, exactly
 * like toggling a normal meal: only under cutoff, no admin permission.
 * "−" decrements the changeable request with the LATEST cutoff (matches the
 * visual row order — the later meal shrinks first) and cancels it at zero;
 * "+" increments an existing request when it can absorb one, otherwise the
 * page opens the guest dialog (a meal choice is needed).
 */

import { ApiClientError } from "@/lib/api";

import { apiJson } from "./api";
import { friendlyError } from "./format";
import type { GuestMealCancelResponse, GuestMealPatchResponse } from "./types";

export interface GuestStepTarget {
  id: string;
  quantity: number;
  cutoffAt: string;
  mealName: string;
}

export type GuestStepResult =
  | { kind: "ok"; cancelled: boolean; mealName: string; quantity: number }
  /** No request can absorb the +1 — the caller should open the guest dialog. */
  | { kind: "dialog" }
  | { kind: "error"; code: string; message: string };

const MAX_PER_REQUEST = 10;

/**
 * The request a ± step would touch — the changeable request (cutoff in the
 * future) with the LATEST cutoff, matching the visual row order (the later
 * meal adjusts first). "−" always uses [0]; "+" skips requests already at
 * the per-request cap. Null = nothing to adjust (dialog or locked).
 */
export function pickGuestStepTarget(
  dayGuests: GuestStepTarget[],
  delta: 1 | -1,
  now: number
): GuestStepTarget | null {
  const changeable = dayGuests
    .filter((g) => new Date(g.cutoffAt).getTime() > now)
    .sort((a, b) => (a.cutoffAt < b.cutoffAt ? 1 : a.cutoffAt > b.cutoffAt ? -1 : a.id < b.id ? 1 : -1));
  if (delta === -1) return changeable[0] ?? null;
  return changeable.find((g) => g.quantity < MAX_PER_REQUEST) ?? null;
}

export async function stepGuestMeals(
  dayGuests: GuestStepTarget[],
  delta: 1 | -1,
  now: number
): Promise<GuestStepResult> {
  try {
    if (delta === -1) {
      const target = pickGuestStepTarget(dayGuests, delta, now);
      if (!target) {
        return {
          kind: "error",
          code: "MEAL_CUTOFF_PASSED",
          message: "Guest meals for this day are locked — the cutoff already passed.",
        };
      }
      if (target.quantity <= 1) {
        await apiJson<GuestMealCancelResponse>(`/api/v1/guest-meals/${target.id}/cancel`, "POST", {});
        return { kind: "ok", cancelled: true, mealName: target.mealName, quantity: 0 };
      }
      const res = await apiJson<GuestMealPatchResponse>(`/api/v1/guest-meals/${target.id}`, "PATCH", {
        quantity: target.quantity - 1,
        expectedQuantity: target.quantity,
      });
      return { kind: "ok", cancelled: false, mealName: target.mealName, quantity: res.quantity };
    }

    // delta === +1 — quick-add onto an existing request when possible.
    const target = pickGuestStepTarget(dayGuests, delta, now);
    if (!target) return { kind: "dialog" };
    const res = await apiJson<GuestMealPatchResponse>(`/api/v1/guest-meals/${target.id}`, "PATCH", {
      quantity: target.quantity + 1,
      expectedQuantity: target.quantity,
    });
    return { kind: "ok", cancelled: false, mealName: target.mealName, quantity: res.quantity };
  } catch (err) {
    if (err instanceof ApiClientError) {
      return { kind: "error", code: err.code, message: err.message };
    }
    return { kind: "error", code: "NETWORK", message: friendlyError(err) };
  }
}
