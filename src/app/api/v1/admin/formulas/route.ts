/**
 * GET /api/v1/admin/formulas — multi-formula definitions & active versions (auth ADMIN).
 * POST /api/v1/admin/formulas — create or update formula definition metadata.
 */
import { z } from "zod";
import { route, parseBody } from "@/lib/auth/guard";
import { db } from "@/lib/db";
import { getInstitution } from "@/lib/institution";
import { FormulaAst } from "@/lib/domain/formula/ast";
import { currentPeriodBounds, periodBounds } from "@/lib/domain/formula/period-variables";
import {
  createFormulaVersion,
  ensureFormulaDefinition,
  formulaEstimate,
  resolveFormulaVersionForPeriod,
  serializeFormulaVersion,
} from "@/lib/domain/formula/versions";
import { isValidVariableKey } from "@/lib/domain/formula/variables";
import { ApiError, CODES } from "@/lib/errors";

export const dynamic = "force-dynamic";

export const GET = route({ auth: "ADMIN" }, async (ctx) => {
  const url = new URL(ctx.req.url);
  const selectedFormulaKey = url.searchParams.get("outputVariable") ?? "meal_charge";
  const periodParam = url.searchParams.get("period");

  const inst = await getInstitution(ctx.institutionId);
  const tz = inst?.timezone ?? "UTC";
  const bounds = periodParam
    ? (() => {
        const [y, m] = periodParam.split("-").map(Number);
        return periodBounds(y, m, tz);
      })()
    : currentPeriodBounds(tz);

  // Ensure default Meal Charge exists
  await ensureFormulaDefinition(ctx.institutionId, "meal_charge");

  // Fetch all active formula definitions
  const allDefinitions = await db.formulaDefinition.findMany({
    where: { institutionId: ctx.institutionId, archivedAt: null },
    include: {
      versions: {
        orderBy: { version: "desc" },
      },
    },
    orderBy: { createdAt: "asc" },
  });

  const selectedDef =
    allDefinitions.find((d) => d.outputVariableKey === selectedFormulaKey) ??
    allDefinitions[0];

  const versions = selectedDef ? selectedDef.versions : [];
  const activeVersion =
    versions.find((v) => v.id === selectedDef?.activeVersionId) ??
    versions.find((v) => v.active) ??
    versions[0] ??
    null;

  const currentPeriodVersion = await resolveFormulaVersionForPeriod(
    ctx.institutionId,
    bounds.startAt,
    selectedDef?.outputVariableKey ?? "meal_charge"
  );

  let estimate: any = null;
  if (activeVersion) {
    try {
      const ast = JSON.parse(activeVersion.compiledAstJson) as FormulaAst;
      estimate = await formulaEstimate(ctx.institutionId, ast, bounds.year, bounds.month);
    } catch {
      // ignore
    }
  }

  return {
    data: {
      definitions: allDefinitions.map((d) => ({
        id: d.id,
        name: d.name,
        description: d.description,
        outputVariableKey: d.outputVariableKey,
        scope: d.scope,
        status: d.status,
        activeVersion: d.versions.find((v) => v.active) ? serializeFormulaVersion(d.versions.find((v) => v.active)) : null,
        versionsCount: d.versions.length,
      })),
      selectedDefinition: selectedDef
        ? {
            id: selectedDef.id,
            name: selectedDef.name,
            description: selectedDef.description,
            outputVariableKey: selectedDef.outputVariableKey,
            scope: selectedDef.scope,
          }
        : null,
      activeVersion: activeVersion ? serializeFormulaVersion(activeVersion) : null,
      history: versions.map((v) => serializeFormulaVersion(v)),
      currentPeriod: { year: bounds.year, month: bounds.month, key: bounds.periodKey },
      currentPeriodVersion: currentPeriodVersion ? serializeFormulaVersion(currentPeriodVersion) : null,
      estimate,
    },
  };
});

const createDefSchema = z.object({
  name: z.string().min(1).max(100),
  outputVariableKey: z.string().min(1).max(64),
  description: z.string().max(500).optional(),
  scope: z.enum(["GLOBAL", "BILLING_PERIOD", "RESIDENT", "MEAL"]).default("BILLING_PERIOD"),
  mode: z.enum(["FORMULA", "NATURAL_LANGUAGE"]).optional(),
  source: z.string().optional(),
  reason: z.string().optional(),
});

export const POST = route({ auth: "ADMIN" }, async (ctx) => {
  const body = await parseBody(ctx.req, createDefSchema);
  const key = body.outputVariableKey.trim().toLowerCase();

  if (!isValidVariableKey(key)) {
    throw new ApiError(
      CODES.VALIDATION_FAILED,
      `Output variable key '${key}' is invalid. Keys must be lowercase snake_case.`,
      422
    );
  }

  const existing = await db.formulaDefinition.findFirst({
    where: { institutionId: ctx.institutionId, outputVariableKey: key, archivedAt: null },
  });

  if (existing) {
    throw new ApiError(
      CODES.VALIDATION_FAILED,
      `A formula producing '${key}' already exists (${existing.name}).`,
      422
    );
  }

  const def = await db.formulaDefinition.create({
    data: {
      institutionId: ctx.institutionId,
      name: body.name.trim(),
      outputVariableKey: key,
      description: body.description?.trim() ?? null,
      scope: body.scope,
      status: "ACTIVE",
    },
  });

  // If initial formula expression or natural language source is provided, create version 1
  if (body.source && body.source.trim()) {
    try {
      await createFormulaVersion({
        institutionId: ctx.institutionId,
        adminUserId: ctx.user.id,
        requestId: ctx.requestId,
        outputVariableKey: key,
        name: body.name.trim(),
        mode: body.mode ?? "FORMULA",
        source: body.source.trim(),
        reason: body.reason ?? "Initial formula setup",
        effective: "CURRENT_OPEN",
        confirmImpact: true,
      });
    } catch (err) {
      // If version creation fails due to syntax error, delete definition or throw
      await db.formulaDefinition.delete({ where: { id: def.id } });
      throw err;
    }
  }

  return { data: def };
});
