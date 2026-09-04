/**
 * THE MEAL ENGINE — deterministic state precedence (spec §24-36, §28).
 *
 * Materialization is LAZY (documented decision): meal_instances and
 * resident_meals rows are created on demand when a resident or admin queries a
 * date range — never eagerly rewritten. Historical rows are never mutated by
 * definition edits (immutable MealDefinitionVersion snapshots).
 *
 * Precedence (evaluateResidentMeal — THE order, spec §28):
 *   !visible → NOT_AVAILABLE/NOT_VISIBLE
 *   calendarDisabled → NOT_AVAILABLE/CALENDAR_DISABLED
 *   joinedAfterCutoff / membershipInactive → NOT_AVAILABLE/JOINED_AFTER_CUTOFF|MEMBERSHIP_INACTIVE
 *   onLeave → ON_LEAVE/LEAVE_APPROVED
 *   restricted (deficit policy) → NOT_AVAILABLE/POLICY_RESTRICTED
 *   adminOverride set → that state/ADMIN_OVERRIDE
 *   selected ?? baseline → RESIDENT_SELECTION | BASELINE_DEFAULT
 *
 * Server time is authoritative for every cutoff/lock decision (spec §16).
 */
import { db } from "@/lib/db";
import { getInstitution, type InstitutionContext } from "@/lib/institution";
import { isMealRestricted } from "@/lib/domain/funds";
import { addDaysToKey, computeCutoffAt, computeServiceWindow, weekdayOfKey } from "@/lib/time";
import { ApiError, CODES } from "@/lib/errors";

type Client = any; // prisma client or interactive transaction client

export const DAY_MS = 86_400_000;

/* ----------------------------------------------------------------------------
 * Small pure helpers
 * ------------------------------------------------------------------------- */

/** "YYYY-MM-DD" of a UTC date (serviceDate is stored as local-date-midnight-UTC). */
export function keyOfUtcDate(d: Date): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
}

/** Floor any instant to its UTC calendar-day midnight. */
export function utcDayFloor(d: Date): Date {
  return new Date(Math.floor(d.getTime() / DAY_MS) * DAY_MS);
}

/** Calendar day count of an inclusive [fromKey, toKey] range. */
export function dayCountBetween(fromKey: string, toKey: string): number {
  if (fromKey > toKey) return -1;
  return Math.round((localMidnight(toKey).getTime() - localMidnight(fromKey).getTime()) / DAY_MS) + 1;
}

function localMidnight(key: string): Date {
  const [y, m, d] = key.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d, 0, 0, 0, 0));
}

/** True when the day (UTC-midnight) is covered by [start,end] of a dated row. */
export function dayCoveredBy(day: Date, row: { startDate: Date; endDate: Date }): boolean {
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

/** Prisma P2002 (unique violation) detector — used by create-skip loops. */
export function isUniqueViolation(e: unknown): boolean {
  return typeof e === "object" && e !== null && (e as { code?: string }).code === "P2002";
}

/** Instance status from server time: OPEN → LOCKED → COMPLETED. */
export function computeInstanceStatus(now: Date, cutoffAt: Date, serviceEndAt: Date): string {
  if (now.getTime() < cutoffAt.getTime()) return "OPEN";
  if (now.getTime() < serviceEndAt.getTime()) return "LOCKED";
  return "COMPLETED";
}

/** Resolve institution or fail loudly (misconfiguration is a 500, never silent). */
export async function requireInstitutionContext(institutionId: string): Promise<InstitutionContext> {
  const inst = await getInstitution(institutionId);
  if (!inst) {
    throw new ApiError(CODES.INTERNAL, "The institution is not configured. Please contact support.", 500);
  }
  return inst;
}

/** Parse "1,2,3" weekdays CSV → Set<number> (Mon=1..Sun=7). */
export function parseWeekdaysCsv(csv: string | null | undefined): Set<number> {
  const out = new Set<number>();
  if (!csv) return out;
  for (const part of String(csv).split(",")) {
    const n = Number(part.trim());
    if (Number.isInteger(n) && n >= 1 && n <= 7) out.add(n);
  }
  return out;
}

/** Effective cutoff offset in days for a cutoff strategy. */
export function cutoffOffsetFor(def: {
  cutoffStrategy?: string | null;
  cutoffOffsetDays?: number | null;
}): number {
  if (def.cutoffStrategy === "PREVIOUS_DAY") return 1;
  if (def.cutoffStrategy === "CUSTOM_OFFSET") {
    return Math.max(0, Math.min(30, Number(def.cutoffOffsetDays) || 0));
  }
  return 0; // SAME_DAY
}

/** Parse a definition version snapshot JSON (never throws). */
export function parseSnapshot(json: string | null | undefined): Record<string, any> | null {
  if (!json) return null;
  try {
    const v = JSON.parse(json);
    return typeof v === "object" && v !== null ? v : null;
  } catch {
    return null;
  }
}

/** Full config snapshot for a MealDefinitionVersion (immutable). */
export function snapshotConfig(def: Record<string, any>): Record<string, any> {
  return {
    name: def.name,
    description: def.description ?? null,
    icon: def.icon ?? null,
    colorToken: def.colorToken ?? null,
    mealType: def.mealType ?? "REGULAR",
    defaultState: def.defaultState ?? "ON",
    defaultVisible: def.defaultVisible ?? true,
    pricingStrategy: def.pricingStrategy ?? "FORMULA",
    fixedPriceMinor: def.fixedPriceMinor ?? null,
    scheduleStrategy: def.scheduleStrategy ?? "DAILY",
    weekdaysCsv: def.weekdaysCsv ?? null,
    specificDate: def.specificDate ? keyOfUtcDate(new Date(def.specificDate)) : null,
    serviceStartLocal: def.serviceStartLocal ?? "12:30",
    serviceEndLocal: def.serviceEndLocal ?? "14:00",
    cutoffStrategy: def.cutoffStrategy ?? "SAME_DAY",
    cutoffOffsetDays: def.cutoffOffsetDays ?? 0,
    cutoffLocalTime: def.cutoffLocalTime ?? "09:00",
    internalNotes: def.internalNotes ?? null,
  };
}

/* ----------------------------------------------------------------------------
 * Evaluation — the deterministic precedence
 * ------------------------------------------------------------------------- */

export type MealEvalContext = {
  visible: boolean;
  calendarDisabled: boolean;
  onLeave: boolean;
  restricted: boolean;
  adminOverride: string | null;
  selected: string | null;
  baseline: string;
  membershipInactive: boolean;
  joinedAfterCutoff: boolean;
};

export type EffectiveResult = { effectiveState: string; effectiveReason: string };

/**
 * Normal meal state is calculated first from default + resident choice + leave + restrictions + cutoff.
 */
export function calculateNormalMealState(ctx: MealEvalContext): EffectiveResult {
  if (!ctx.visible) return { effectiveState: "NOT_AVAILABLE", effectiveReason: "NOT_VISIBLE" };
  if (ctx.calendarDisabled) return { effectiveState: "NOT_AVAILABLE", effectiveReason: "CALENDAR_DISABLED" };
  if (ctx.joinedAfterCutoff) return { effectiveState: "NOT_AVAILABLE", effectiveReason: "JOINED_AFTER_CUTOFF" };
  if (ctx.membershipInactive) return { effectiveState: "NOT_AVAILABLE", effectiveReason: "MEMBERSHIP_INACTIVE" };
  if (ctx.onLeave) return { effectiveState: "ON_LEAVE", effectiveReason: "LEAVE_APPROVED" };
  if (ctx.restricted) return { effectiveState: "NOT_AVAILABLE", effectiveReason: "POLICY_RESTRICTED" };
  if (ctx.selected != null) return { effectiveState: ctx.selected, effectiveReason: "RESIDENT_SELECTION" };
  return { effectiveState: ctx.baseline === "OFF" ? "OFF" : "ON", effectiveReason: "BASELINE_DEFAULT" };
}

/**
 * THE precedence (spec §28). Pure function — same inputs, same output.
 * `rm` only supplies adminOverride / selected / baseline via the context.
 *
 * Final state:
 * if admin_override exists:
 *     effective_state = admin_override
 * else:
 *     effective_state = normal_state
 * Show Admin Override only when Admin state is different from normal state.
 */
export function evaluateResidentMeal(
  _rm: Record<string, any> | null,
  ctx: MealEvalContext
): EffectiveResult {
  const normal = calculateNormalMealState(ctx);
  if (ctx.adminOverride != null) {
    if (ctx.adminOverride !== normal.effectiveState) {
      return { effectiveState: ctx.adminOverride, effectiveReason: "ADMIN_OVERRIDE" };
    }
    return normal;
  }
  return normal;
}

/** Deficit restriction gate: false when the policy is off (spec §43). */
export async function isRestrictionActive(
  residentId: string,
  institutionId: string,
  client: Client = db
): Promise<boolean> {
  const inst = await getInstitution(institutionId);
  if (!inst) return false;
  if (!inst.settings.deficitPolicyEnabled || !inst.settings.restrictMealsOnDeficit) return false;
  return isMealRestricted(residentId, client);
}

export type EvalInputs = {
  resident: { id: string; membershipEffectiveFrom: Date | null; membershipEffectiveUntil: Date | null };
  institutionId: string;
  instance: { serviceDate: Date; cutoffAt: Date; mealDefinitionId: string };
  definition: { defaultVisible?: boolean | null; defaultState?: string | null } | null;
  snapshot: Record<string, any> | null;
  rm: { baselineState: string; residentSelectedState: string | null; adminOverrideState: string | null };
  client?: Client;
  overrides?: { onLeave?: boolean; skipPolicy?: boolean; skipCalendar?: boolean };
};

/** Gather live context (calendar, leave, policy, membership) for one resident+instance. */
export async function buildEvalContext(inputs: EvalInputs): Promise<MealEvalContext> {
  const client = inputs.client ?? db;
  const dayStart = utcDayFloor(inputs.instance.serviceDate);
  const dayEnd = new Date(dayStart.getTime() + DAY_MS - 1);

  let calendarDisabled = false;
  if (inputs.overrides?.skipCalendar !== true) {
    const events = await client.calendarEvent.findMany({
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
  }

  let onLeave = inputs.overrides?.onLeave ?? false;
  if (inputs.overrides?.onLeave === undefined) {
    const leaves = await client.leaveRequest.findMany({
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
  }

  const restricted = inputs.overrides?.skipPolicy
    ? false
    : await isRestrictionActive(inputs.resident.id, inputs.institutionId, client);

  const from = inputs.resident.membershipEffectiveFrom;
  const until = inputs.resident.membershipEffectiveUntil;

  const visible =
    inputs.snapshot?.defaultVisible !== undefined && inputs.snapshot?.defaultVisible !== null
      ? Boolean(inputs.snapshot.defaultVisible)
      : inputs.definition?.defaultVisible ?? true;

  return {
    visible,
    calendarDisabled,
    onLeave,
    restricted,
    adminOverride: inputs.rm.adminOverrideState ?? null,
    selected: inputs.rm.residentSelectedState ?? null,
    baseline: inputs.rm.baselineState === "OFF" ? "OFF" : "ON",
    membershipInactive: !!(until && until.getTime() < dayStart.getTime()),
    joinedAfterCutoff: !!(from && from.getTime() > inputs.instance.cutoffAt.getTime()),
  };
}

/* ----------------------------------------------------------------------------
 * 1) ensureInstancesForRange — lazy materialization of meal_instances
 * ------------------------------------------------------------------------- */

/**
 * For each ACTIVE MealDefinition (archivedAt null) × each date in range,
 * create the MealInstance if missing. Idempotent; the UNIQUE
 * (mealDefinitionId, serviceDate) constraint is the final guard (P2002 → skip).
 * Returns the number of instances created.
 */
export async function ensureInstancesForRange(
  institutionId: string,
  tz: string,
  fromKey: string,
  toKey: string,
  client: Client = db
): Promise<number> {
  if (fromKey > toKey) return 0;
  const defs = (await client.mealDefinition.findMany({
    where: { institutionId, archivedAt: null },
  })) as Record<string, any>[];
  if (defs.length === 0) return 0;

  const fromMid = localMidnight(fromKey);
  const toMid = localMidnight(toKey);
  const existing = (await client.mealInstance.findMany({
    where: { institutionId, serviceDate: { gte: fromMid, lte: toMid } },
    select: { mealDefinitionId: true, serviceDate: true },
  })) as { mealDefinitionId: string; serviceDate: Date }[];
  const existingKeys = new Set(existing.map((i) => `${i.mealDefinitionId}|${keyOfUtcDate(i.serviceDate)}`));

  const dates: string[] = [];
  for (let k = fromKey; k <= toKey && dates.length < 400; k = addDaysToKey(k, 1)) dates.push(k);

  const now = new Date();
  let created = 0;

  for (const def of defs) {
    const weekdays = parseWeekdaysCsv(def.weekdaysCsv);
    const oneTimeKey = def.specificDate ? keyOfUtcDate(new Date(def.specificDate)) : null;

    // Latest immutable version — create v1 snapshot if none exists.
    let latest = await client.mealDefinitionVersion.findFirst({
      where: { mealDefinitionId: def.id },
      orderBy: { version: "desc" },
    });
    if (!latest) {
      latest = await client.mealDefinitionVersion.create({
        data: {
          mealDefinitionId: def.id,
          version: 1,
          configSnapshotJson: JSON.stringify(snapshotConfig(def)),
          createdByUserId: null,
        },
      });
    }

    const offsetDays = cutoffOffsetFor(def);

    for (const dateKey of dates) {
      if (def.scheduleStrategy === "WEEKDAYS" && !weekdays.has(weekdayOfKey(dateKey))) continue;
      if (def.scheduleStrategy === "ONE_TIME" && oneTimeKey !== dateKey) continue;
      if (existingKeys.has(`${def.id}|${dateKey}`)) continue;

      const cutoffAt = computeCutoffAt(dateKey, def.cutoffLocalTime, offsetDays, tz);
      const window = computeServiceWindow(dateKey, def.serviceStartLocal, def.serviceEndLocal, tz);
      try {
        await client.mealInstance.create({
          data: {
            institutionId,
            mealDefinitionId: def.id,
            mealDefinitionVersionId: latest.id,
            serviceDate: localMidnight(dateKey),
            serviceStartAt: window.startAt,
            serviceEndAt: window.endAt,
            cutoffAt,
            lockAt: cutoffAt,
            status: computeInstanceStatus(now, cutoffAt, window.endAt),
            priceStrategySnapshot: def.pricingStrategy ?? "FORMULA",
            fixedPriceMinorSnapshot: def.fixedPriceMinor ?? null,
          },
        });
        created++;
      } catch (e) {
        if (isUniqueViolation(e)) continue; // concurrent materialization — fine
        throw e;
      }
    }
  }
  return created;
}

/* ----------------------------------------------------------------------------
 * 2) ensureResidentMeals — lazy materialization of resident_meals
 * ------------------------------------------------------------------------- */

/**
 * For each instance in range, create the ResidentMeal row when the resident is
 * an ACTIVE member whose membership window covers the service date. Not created
 * for PENDING_APPROVAL/REJECTED/INACTIVE users, GUEST_ONLY definitions, or dates
 * outside the membership window. Mid-month join after cutoff materializes as
 * NOT_AVAILABLE/JOINED_AFTER_CUTOFF (spec §30 — no retro ON).
 * Returns the number of rows created.
 */
export async function ensureResidentMeals(
  residentId: string,
  institutionId: string,
  tz: string,
  fromKey: string,
  toKey: string,
  client: Client = db
): Promise<number> {
  void tz; // tz not needed here — instances already carry instants
  if (fromKey > toKey) return 0;
  const resident = (await client.user.findUnique({ where: { id: residentId } })) as Record<string, any> | null;
  if (!resident || resident.institutionId !== institutionId) return 0;
  if (resident.status !== "ACTIVE" || resident.role !== "RESIDENT") return 0;

  const fromMid = localMidnight(fromKey);
  const toMid = localMidnight(toKey);
  const instances = (await client.mealInstance.findMany({
    where: { institutionId, serviceDate: { gte: fromMid, lte: toMid } },
    include: { definition: true, definitionVersion: true },
  })) as Record<string, any>[];
  if (instances.length === 0) return 0;

  const existing = (await client.residentMeal.findMany({
    where: { residentId, mealInstanceId: { in: instances.map((i) => i.id) } },
    select: { mealInstanceId: true },
  })) as { mealInstanceId: string }[];
  const existingIds = new Set(existing.map((r) => r.mealInstanceId));

  // Bulk context data for the whole range.
  const disableEvents = (await client.calendarEvent.findMany({
    where: { institutionId, disableMeals: true, startDate: { lte: toMid }, endDate: { gte: fromMid } },
    include: { selectedMeals: { select: { mealDefinitionId: true } } },
  })) as ({ startDate: Date; endDate: Date } & MealScopedRow)[];
  const approvedLeaves = (await client.leaveRequest.findMany({
    where: { residentId, status: "APPROVED", startDate: { lte: toMid }, endDate: { gte: fromMid } },
    include: { selectedMeals: { select: { mealDefinitionId: true } } },
  })) as ({ startDate: Date; endDate: Date } & MealScopedRow)[];
  const restricted = await isRestrictionActive(residentId, institutionId, client);

  const from = resident.membershipEffectiveFrom ? new Date(resident.membershipEffectiveFrom) : null;
  const until = resident.membershipEffectiveUntil ? new Date(resident.membershipEffectiveUntil) : null;

  let created = 0;
  for (const inst of instances) {
    if (existingIds.has(inst.id)) continue;
    if (inst.definition?.mealType === "GUEST_ONLY") continue; // separate guest domain

    const dayStart = utcDayFloor(inst.serviceDate);
    const dayEnd = new Date(dayStart.getTime() + DAY_MS - 1);
    if (from && from.getTime() > dayEnd.getTime()) continue; // joins after this day — not a member
    if (until && until.getTime() < dayStart.getTime()) continue; // membership ended before this day

    const snapshot = parseSnapshot(inst.definitionVersion?.configSnapshotJson);
    const baseline = snapshot?.defaultState === "OFF" || snapshot?.defaultState === "ON"
      ? snapshot.defaultState
      : inst.definition?.defaultState === "OFF" ? "OFF" : "ON";
    const visible =
      snapshot?.defaultVisible !== undefined && snapshot?.defaultVisible !== null
        ? Boolean(snapshot.defaultVisible)
        : inst.definition?.defaultVisible ?? true;

    const ctx: MealEvalContext = {
      visible,
      calendarDisabled: disableEvents.some(
        (e) => dayCoveredBy(dayStart, e) && scopedRowAffectsMeal(e, inst.mealDefinitionId)
      ),
      onLeave: approvedLeaves.some(
        (l) => dayCoveredBy(dayStart, l) && scopedRowAffectsMeal(l, inst.mealDefinitionId)
      ),
      restricted,
      adminOverride: null,
      selected: null,
      baseline: baseline === "OFF" ? "OFF" : "ON",
      membershipInactive: false, // not possible for rows we create (window checked above)
      joinedAfterCutoff: !!(from && from.getTime() > inst.cutoffAt.getTime()),
    };
    const result = evaluateResidentMeal(null, ctx);

    try {
      await client.residentMeal.create({
        data: {
          institutionId,
          residentId,
          mealInstanceId: inst.id,
          baselineState: ctx.baseline,
          effectiveState: result.effectiveState,
          effectiveReason: result.effectiveReason,
          policyState: restricted ? "RESTRICTED" : null,
          leaveState: ctx.onLeave ? "ON_LEAVE" : null,
        },
      });
      created++;
    } catch (e) {
      if (isUniqueViolation(e)) continue;
      throw e;
    }
  }
  return created;
}

/* ----------------------------------------------------------------------------
 * 3) refreshAndLock — freeze effective state at cutoff (spec §36)
 * ------------------------------------------------------------------------- */

/**
 * For every instance in range whose cutoff has passed (cutoffAt <= now):
 * refresh instance status (LOCKED/COMPLETED) and lock every ResidentMeal that
 * is not locked yet — evaluating the final effective state at lock time and
 * writing lockedAt. Runs inside the caller's transaction when passed `client`.
 */
export async function refreshAndLock(
  institutionId: string,
  tz: string,
  residentId: string | null,
  fromKey: string,
  toKey: string,
  client: Client = db
): Promise<{ lockedResidentMeals: number; updatedInstances: number }> {
  void tz;
  const empty = { lockedResidentMeals: 0, updatedInstances: 0 };
  if (fromKey > toKey) return empty;

  const now = new Date();
  const fromMid = localMidnight(fromKey);
  const toMid = localMidnight(toKey);
  const instances = (await client.mealInstance.findMany({
    where: { institutionId, serviceDate: { gte: fromMid, lte: toMid }, cutoffAt: { lte: now } },
  })) as Record<string, any>[];
  if (instances.length === 0) return empty;

  let updatedInstances = 0;
  for (const inst of instances) {
    const target = computeInstanceStatus(now, new Date(inst.cutoffAt), new Date(inst.serviceEndAt));
    if (inst.status !== target) {
      await client.mealInstance.update({ where: { id: inst.id }, data: { status: target } });
      updatedInstances++;
    }
  }

  const instanceIds = instances.map((i) => i.id);
  const rms = (await client.residentMeal.findMany({
    where: {
      mealInstanceId: { in: instanceIds },
      lockedAt: null,
      ...(residentId ? { residentId } : {}),
    },
  })) as Record<string, any>[];
  if (rms.length === 0) return { lockedResidentMeals: 0, updatedInstances };

  // Bulk context for the lock sweep.
  const instanceRows = (await client.mealInstance.findMany({
    where: { id: { in: instanceIds } },
    include: { definition: true, definitionVersion: true },
  })) as Record<string, any>[];
  const instById = new Map(instanceRows.map((i) => [i.id, i]));

  const residentIds = [...new Set(rms.map((r) => r.residentId))];
  const residents = (await client.user.findMany({
    where: { id: { in: residentIds } },
  })) as Record<string, any>[];
  const residentById = new Map(residents.map((r) => [r.id, r]));

  const disableEvents = (await client.calendarEvent.findMany({
    where: { institutionId, disableMeals: true, startDate: { lte: toMid }, endDate: { gte: fromMid } },
    include: { selectedMeals: { select: { mealDefinitionId: true } } },
  })) as ({ startDate: Date; endDate: Date; createdAt: Date } & MealScopedRow)[];
  const leaves = (await client.leaveRequest.findMany({
    where: { residentId: { in: residentIds }, status: "APPROVED", startDate: { lte: toMid }, endDate: { gte: fromMid } },
    include: { selectedMeals: { select: { mealDefinitionId: true } } },
  })) as ({ residentId: string; startDate: Date; endDate: Date; reviewedAt: Date | null } & MealScopedRow)[];

  // Policy only when enabled (avoids per-resident funds queries otherwise).
  const inst = await getInstitution(institutionId);
  const policyOn = !!inst?.settings.deficitPolicyEnabled && !!inst?.settings.restrictMealsOnDeficit;
  const restrictedByResident = new Map<string, boolean>();
  if (policyOn) {
    for (const rid of residentIds) {
      restrictedByResident.set(rid, await isMealRestricted(rid, client));
    }
  }

  let locked = 0;
  for (const rm of rms) {
    const instRow = instById.get(rm.mealInstanceId);
    const resident = residentById.get(rm.residentId);
    if (!instRow || !resident) continue;
    const dayStart = utcDayFloor(new Date(instRow.serviceDate));
    const from = resident.membershipEffectiveFrom ? new Date(resident.membershipEffectiveFrom) : null;
    const until = resident.membershipEffectiveUntil ? new Date(resident.membershipEffectiveUntil) : null;
    const snapshot = parseSnapshot(instRow.definitionVersion?.configSnapshotJson);
    const visible =
      snapshot?.defaultVisible !== undefined && snapshot?.defaultVisible !== null
        ? Boolean(snapshot.defaultVisible)
        : instRow.definition?.defaultVisible ?? true;

    const ctx: MealEvalContext = {
      visible,
      // Spec §36 freeze-at-cutoff + §154 promise: facts that appeared AFTER
      // the cutoff (leave approved late, calendar event created late) must not
      // retroactively flip a cutoff-passed meal when the row locks late —
      // only facts already known at cutoff time participate in the frozen
      // evaluation. The leave-approve route's preview ("meals whose cutoff
      // already passed will not change") stays truthful.
      calendarDisabled: disableEvents.some(
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
      restricted: restrictedByResident.get(rm.residentId) ?? false,
      adminOverride: rm.adminOverrideState ?? null,
      selected: rm.residentSelectedState ?? null,
      baseline: rm.baselineState === "OFF" ? "OFF" : "ON",
      membershipInactive: !!(until && until.getTime() < dayStart.getTime()),
      joinedAfterCutoff: !!(from && from.getTime() > new Date(instRow.cutoffAt).getTime()),
    };
    const result = evaluateResidentMeal(rm, ctx);
    await client.residentMeal.update({
      where: { id: rm.id },
      data: {
        effectiveState: result.effectiveState,
        effectiveReason: result.effectiveReason,
        policyState: ctx.restricted ? "RESTRICTED" : null,
        leaveState: ctx.onLeave ? "ON_LEAVE" : null,
        lockedAt: now, // freeze (spec §36)
      },
    });
    locked++;
  }
  return { lockedResidentMeals: locked, updatedInstances };
}

/* ----------------------------------------------------------------------------
 * 3b) refreshUnlockedEffective — live re-evaluation of unlocked rows
 * ------------------------------------------------------------------------- */

/**
 * Re-evaluate every UNLOCKED ResidentMeal in range against live facts
 * (calendar events, approved leave, deficit policy, membership). Locked rows
 * are frozen (spec §36) and never touched. Rows whose computed state is
 * unchanged are not written (idempotent reads). `version` is NOT bumped — the
 * optimistic-concurrency token only guards resident selections.
 * Called by the read paths so calendar/leave/policy changes reflect without
 * eager rewrites (lazy materialization — rows are never rewritten eagerly).
 */
export async function refreshUnlockedEffective(
  institutionId: string,
  residentId: string | null,
  fromKey: string,
  toKey: string,
  client: Client = db
): Promise<number> {
  if (fromKey > toKey) return 0;
  const fromMid = localMidnight(fromKey);
  const toMid = localMidnight(toKey);
  const rms = (await client.residentMeal.findMany({
    where: {
      lockedAt: null,
      ...(residentId ? { residentId } : {}),
      mealInstance: { institutionId, serviceDate: { gte: fromMid, lte: toMid } },
    },
  })) as Record<string, any>[];
  if (rms.length === 0) return 0;

  const instanceIds = [...new Set(rms.map((r) => r.mealInstanceId))];
  const instanceRows = (await client.mealInstance.findMany({
    where: { id: { in: instanceIds } },
    include: { definition: true, definitionVersion: true },
  })) as Record<string, any>[];
  const instById = new Map(instanceRows.map((i) => [i.id, i]));

  const residentIds = [...new Set(rms.map((r) => r.residentId))];
  const residents = (await client.user.findMany({
    where: { id: { in: residentIds } },
  })) as Record<string, any>[];
  const residentById = new Map(residents.map((r) => [r.id, r]));

  const disableEvents = (await client.calendarEvent.findMany({
    where: { institutionId, disableMeals: true, startDate: { lte: toMid }, endDate: { gte: fromMid } },
    include: { selectedMeals: { select: { mealDefinitionId: true } } },
  })) as ({ startDate: Date; endDate: Date } & MealScopedRow)[];
  const leaves = (await client.leaveRequest.findMany({
    where: { residentId: { in: residentIds }, status: "APPROVED", startDate: { lte: toMid }, endDate: { gte: fromMid } },
    include: { selectedMeals: { select: { mealDefinitionId: true } } },
  })) as ({ residentId: string; startDate: Date; endDate: Date } & MealScopedRow)[];

  const inst = await getInstitution(institutionId);
  const policyOn = !!inst?.settings.deficitPolicyEnabled && !!inst?.settings.restrictMealsOnDeficit;
  const restrictedByResident = new Map<string, boolean>();
  if (policyOn) {
    for (const rid of residentIds) {
      restrictedByResident.set(rid, await isMealRestricted(rid, client));
    }
  }

  let updated = 0;
  for (const rm of rms) {
    const instRow = instById.get(rm.mealInstanceId);
    const resident = residentById.get(rm.residentId);
    if (!instRow || !resident) continue;
    const dayStart = utcDayFloor(new Date(instRow.serviceDate));
    const from = resident.membershipEffectiveFrom ? new Date(resident.membershipEffectiveFrom) : null;
    const until = resident.membershipEffectiveUntil ? new Date(resident.membershipEffectiveUntil) : null;
    const snapshot = parseSnapshot(instRow.definitionVersion?.configSnapshotJson);
    const visible =
      snapshot?.defaultVisible !== undefined && snapshot?.defaultVisible !== null
        ? Boolean(snapshot.defaultVisible)
        : instRow.definition?.defaultVisible ?? true;

    const ctx: MealEvalContext = {
      visible,
      calendarDisabled: disableEvents.some(
        (e) => dayCoveredBy(dayStart, e) && scopedRowAffectsMeal(e, instRow.mealDefinitionId)
      ),
      onLeave: leaves.some(
        (l) =>
          l.residentId === rm.residentId &&
          dayCoveredBy(dayStart, l) &&
          scopedRowAffectsMeal(l, instRow.mealDefinitionId)
      ),
      restricted: restrictedByResident.get(rm.residentId) ?? false,
      adminOverride: rm.adminOverrideState ?? null,
      selected: rm.residentSelectedState ?? null,
      baseline: rm.baselineState === "OFF" ? "OFF" : "ON",
      membershipInactive: !!(until && until.getTime() < dayStart.getTime()),
      joinedAfterCutoff: !!(from && from.getTime() > new Date(instRow.cutoffAt).getTime()),
    };
    const result = evaluateResidentMeal(rm, ctx);
    const nextPolicyState = ctx.restricted ? "RESTRICTED" : null;
    const nextLeaveState = ctx.onLeave ? "ON_LEAVE" : null;
    if (
      result.effectiveState === rm.effectiveState &&
      result.effectiveReason === rm.effectiveReason &&
      nextPolicyState === (rm.policyState ?? null) &&
      nextLeaveState === (rm.leaveState ?? null)
    ) {
      continue; // no change — no write (idempotent reads)
    }
    await client.residentMeal.update({
      where: { id: rm.id },
      data: {
        effectiveState: result.effectiveState,
        effectiveReason: result.effectiveReason,
        policyState: nextPolicyState,
        leaveState: nextLeaveState,
      },
    });
    updated++;
  }
  return updated;
}

/* ----------------------------------------------------------------------------
 * Serializers (stable response shapes shared by routes)
 * ------------------------------------------------------------------------- */

export type SerializedInstance = {
  id: string;
  mealInstanceId: string;
  name: string;
  icon: string | null;
  colorToken: string | null;
  mealType: string;
  serviceDate: string;
  serviceWindow: { startAt: string; endAt: string };
  cutoffAt: string;
  status: string;
  pricing: { strategy: string; fixedPriceMinor: number | null };
};

export function serializeMealInstance(
  inst: Record<string, any>,
  def: Record<string, any> | null | undefined
): SerializedInstance {
  return {
    id: inst.id,
    mealInstanceId: inst.id,
    name: def?.name ?? "Meal",
    icon: def?.icon ?? null,
    colorToken: def?.colorToken ?? null,
    mealType: def?.mealType ?? "REGULAR",
    serviceDate: keyOfUtcDate(new Date(inst.serviceDate)),
    serviceWindow: {
      startAt: new Date(inst.serviceStartAt).toISOString(),
      endAt: new Date(inst.serviceEndAt).toISOString(),
    },
    cutoffAt: new Date(inst.cutoffAt).toISOString(),
    status: inst.status,
    pricing: {
      strategy: inst.priceStrategySnapshot ?? "FORMULA",
      fixedPriceMinor: inst.fixedPriceMinorSnapshot ?? null,
    },
  };
}
