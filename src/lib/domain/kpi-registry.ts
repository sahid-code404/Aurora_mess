import { createHash } from "node:crypto";
import { db } from "@/lib/db";
import { appendAudit } from "@/lib/audit";
import { ApiError, CODES } from "@/lib/errors";

export type KpiSourceMode = "NATIVE" | "VARIABLE";

export type KpiCatalogEntry = {
  key: string;
  surface: string;
  nativeLabel: string;
  description: string;
  defaultSourceMode: KpiSourceMode;
  defaultSourceVariableKey: string | null;
};

export type KpiConfigItem = {
  label: string;
  enabled: boolean;
  sourceMode: KpiSourceMode;
  sourceVariableKey: string | null;
};

export type KpiConfigSnapshot = {
  schemaVersion: 1;
  items: Record<string, KpiConfigItem>;
};

export const KPI_REGISTRY_RULE_KEY = "kpi_presentation";
export const KPI_REGISTRY_POLICY_TYPE = "KPI_PRESENTATION";

/**
 * Stable catalog of primary Admin KPI cards. Values stay NATIVE unless there is
 * an exact authoritative Variable/Formula equivalent. This prevents a visual
 * customization from silently changing accounting semantics.
 */
export const KPI_CATALOG: KpiCatalogEntry[] = [
  // Dashboard
  { key: "dashboard.residents", surface: "dashboard", nativeLabel: "Residents", description: "Active residents shown on the Admin home page.", defaultSourceMode: "NATIVE", defaultSourceVariableKey: null },
  { key: "dashboard.meals", surface: "dashboard", nativeLabel: "Meals", description: "Today's resident and guest serving count.", defaultSourceMode: "NATIVE", defaultSourceVariableKey: null },
  { key: "dashboard.funds", surface: "dashboard", nativeLabel: "Funds", description: "Current available institution cash.", defaultSourceMode: "VARIABLE", defaultSourceVariableKey: "available_funds" },
  { key: "dashboard.rate", surface: "dashboard", nativeLabel: "Rate", description: "Current live meal-charge formula result.", defaultSourceMode: "VARIABLE", defaultSourceVariableKey: "meal_charge" },

  // Formula & Variable page itself
  { key: "formulas.meal_charge", surface: "formulas", nativeLabel: "Meal Charge", description: "Current meal-charge formula result.", defaultSourceMode: "VARIABLE", defaultSourceVariableKey: "meal_charge" },
  { key: "formulas.formulas", surface: "formulas", nativeLabel: "Formulas", description: "Number of configured calculated outputs.", defaultSourceMode: "NATIVE", defaultSourceVariableKey: null },
  { key: "formulas.parameters", surface: "formulas", nativeLabel: "Parameters", description: "Number of variables available to calculations.", defaultSourceMode: "NATIVE", defaultSourceVariableKey: null },

  // Expenses
  { key: "expenses.meal_cost", surface: "expenses", nativeLabel: "Meal Cost", description: "Approved expenses classified as Meal Cost.", defaultSourceMode: "VARIABLE", defaultSourceVariableKey: "total_meal_expense" },
  { key: "expenses.extra_cost", surface: "expenses", nativeLabel: "Extra Cost", description: "Approved expenses classified as Extra Cost.", defaultSourceMode: "VARIABLE", defaultSourceVariableKey: "total_extra_expense" },
  { key: "expenses.total", surface: "expenses", nativeLabel: "Total Expenses", description: "All approved expenses for the selected period.", defaultSourceMode: "VARIABLE", defaultSourceVariableKey: "total_approved_expense" },
  { key: "expenses.remaining", surface: "expenses", nativeLabel: "Remaining", description: "Current available institution cash.", defaultSourceMode: "VARIABLE", defaultSourceVariableKey: "available_funds" },
  { key: "expenses.pending", surface: "expenses", nativeLabel: "Pending", description: "Expenses waiting for Admin review.", defaultSourceMode: "NATIVE", defaultSourceVariableKey: null },

  // Payments
  { key: "payments.received", surface: "payments", nativeLabel: "Received", description: "Approved resident payments in the selected period.", defaultSourceMode: "VARIABLE", defaultSourceVariableKey: "total_payments_approved" },
  { key: "payments.pending", surface: "payments", nativeLabel: "Pending", description: "Payments waiting for Admin review.", defaultSourceMode: "NATIVE", defaultSourceVariableKey: null },
  { key: "payments.refunds", surface: "payments", nativeLabel: "Refunds", description: "Completed cash refunds for the selected period.", defaultSourceMode: "VARIABLE", defaultSourceVariableKey: "total_refunds" },

  // Funds
  { key: "funds.deposits", surface: "funds", nativeLabel: "Deposits", description: "Approved resident deposits for the selected period.", defaultSourceMode: "VARIABLE", defaultSourceVariableKey: "total_deposits" },
  { key: "funds.available", surface: "funds", nativeLabel: "Available", description: "Current available institution cash.", defaultSourceMode: "VARIABLE", defaultSourceVariableKey: "available_funds" },
  { key: "funds.deficit", surface: "funds", nativeLabel: "Deficit", description: "Resident deficit total from the Funds read model.", defaultSourceMode: "NATIVE", defaultSourceVariableKey: null },

  // Billing — these remain native because they are frozen bill/read-model facts.
  { key: "billing.billed", surface: "billing", nativeLabel: "Billed", description: "Total generated bill value for the selected billing period.", defaultSourceMode: "NATIVE", defaultSourceVariableKey: null },
  { key: "billing.collected", surface: "billing", nativeLabel: "Collected", description: "Amount collected against generated bills.", defaultSourceMode: "NATIVE", defaultSourceVariableKey: null },
  { key: "billing.overdue", surface: "billing", nativeLabel: "Overdue", description: "Number of bills currently past due.", defaultSourceMode: "NATIVE", defaultSourceVariableKey: null },

  // Residents
  { key: "residents.total", surface: "residents", nativeLabel: "Total", description: "Registered resident count.", defaultSourceMode: "NATIVE", defaultSourceVariableKey: null },
  { key: "residents.active", surface: "residents", nativeLabel: "Active", description: "Active resident count.", defaultSourceMode: "NATIVE", defaultSourceVariableKey: null },
  { key: "residents.pending", surface: "residents", nativeLabel: "Pending", description: "Residents waiting for approval or review.", defaultSourceMode: "NATIVE", defaultSourceVariableKey: null },

  // Tasks
  { key: "tasks.open", surface: "tasks", nativeLabel: "Open", description: "Assigned or accepted tasks still open.", defaultSourceMode: "NATIVE", defaultSourceVariableKey: null },
  { key: "tasks.done", surface: "tasks", nativeLabel: "Done", description: "Approved completed tasks.", defaultSourceMode: "NATIVE", defaultSourceVariableKey: null },
  { key: "tasks.overdue", surface: "tasks", nativeLabel: "Overdue", description: "Open tasks past their due date.", defaultSourceMode: "NATIVE", defaultSourceVariableKey: null },

  // Audit
  { key: "audit.entries", surface: "audit", nativeLabel: "Entries", description: "Audit entries loaded in the current view.", defaultSourceMode: "NATIVE", defaultSourceVariableKey: null },
  { key: "audit.entity_types", surface: "audit", nativeLabel: "Entity Types", description: "Distinct audited entity types in the current view.", defaultSourceMode: "NATIVE", defaultSourceVariableKey: null },
  { key: "audit.action_types", surface: "audit", nativeLabel: "Action Types", description: "Distinct audit actions in the current view.", defaultSourceMode: "NATIVE", defaultSourceVariableKey: null },
];

export const KPI_SURFACE_LABELS: Record<string, string> = {
  dashboard: "Dashboard",
  formulas: "Formula & Variables",
  expenses: "Expenses",
  payments: "Payments",
  funds: "Funds",
  billing: "Billing",
  residents: "Residents",
  tasks: "Tasks",
  audit: "Audit",
};

const catalogByKey = new Map(KPI_CATALOG.map((item) => [item.key, item]));

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function defaultItem(entry: KpiCatalogEntry): KpiConfigItem {
  return {
    label: entry.nativeLabel,
    enabled: true,
    sourceMode: entry.defaultSourceMode,
    sourceVariableKey: entry.defaultSourceVariableKey,
  };
}

export function defaultKpiSnapshot(): KpiConfigSnapshot {
  return {
    schemaVersion: 1,
    items: Object.fromEntries(KPI_CATALOG.map((entry) => [entry.key, defaultItem(entry)])),
  };
}

export function kpiCatalogEntry(key: string): KpiCatalogEntry | null {
  return catalogByKey.get(key) ?? null;
}

export function normalizeKpiSnapshot(raw: unknown): KpiConfigSnapshot {
  const defaults = defaultKpiSnapshot();
  if (!raw || typeof raw !== "object") return defaults;
  const obj = raw as Record<string, unknown>;
  const sourceItems = obj.items && typeof obj.items === "object" ? (obj.items as Record<string, unknown>) : {};

  for (const entry of KPI_CATALOG) {
    const candidate = sourceItems[entry.key];
    if (!candidate || typeof candidate !== "object") continue;
    const row = candidate as Record<string, unknown>;
    const sourceMode: KpiSourceMode = row.sourceMode === "VARIABLE" ? "VARIABLE" : "NATIVE";
    defaults.items[entry.key] = {
      label:
        typeof row.label === "string" && row.label.trim().length > 0
          ? row.label.trim().slice(0, 50)
          : entry.nativeLabel,
      enabled: row.enabled !== false,
      sourceMode,
      sourceVariableKey:
        sourceMode === "VARIABLE" && typeof row.sourceVariableKey === "string" && row.sourceVariableKey.trim()
          ? row.sourceVariableKey.trim()
          : sourceMode === "VARIABLE"
            ? entry.defaultSourceVariableKey
            : null,
    };
  }
  return defaults;
}

function parseStoredSnapshot(row: { rulesJson: string; checksum: string }): KpiConfigSnapshot {
  if (sha256(row.rulesJson) !== row.checksum) {
    throw new ApiError(CODES.RESOURCE_CHANGED, "Stored KPI configuration checksum does not match its contents.", 409);
  }
  try {
    return normalizeKpiSnapshot(JSON.parse(row.rulesJson));
  } catch {
    throw new ApiError(CODES.INTERNAL, "Stored KPI configuration is invalid.", 500);
  }
}

export async function readKpiConfiguration(
  institutionId: string,
  client: any = db
): Promise<{ snapshot: KpiConfigSnapshot; version: number; updatedAt: Date | null }> {
  const definition = await client.ruleDefinition.findUnique({
    where: { institutionId_key: { institutionId, key: KPI_REGISTRY_RULE_KEY } },
    include: {
      versions: {
        where: { status: "ACTIVE" },
        orderBy: { version: "desc" },
        take: 1,
      },
    },
  });
  const version = definition?.versions?.[0];
  if (!version) return { snapshot: defaultKpiSnapshot(), version: 0, updatedAt: null };
  return {
    snapshot: parseStoredSnapshot(version),
    version: version.version,
    updatedAt: version.createdAt,
  };
}

async function serializableWrite<T>(work: (tx: any) => Promise<T>): Promise<T> {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      return await db.$transaction(work, { isolationLevel: "Serializable" });
    } catch (error) {
      const retryable =
        typeof error === "object" && error !== null && "code" in error && (error as { code?: string }).code === "P2034";
      if (!retryable || attempt === 3) throw error;
    }
  }
  throw new Error("KPI_CONFIGURATION_SERIALIZABLE_RETRY_EXHAUSTED");
}

export async function updateKpiConfiguration(input: {
  institutionId: string;
  adminUserId: string;
  requestId: string;
  key: string;
  item: KpiConfigItem;
  reason?: string;
}): Promise<{ snapshot: KpiConfigSnapshot; version: number; updatedAt: Date }> {
  const catalog = kpiCatalogEntry(input.key);
  if (!catalog) throw new ApiError(CODES.NOT_FOUND, "KPI definition not found.", 404);

  return serializableWrite(async (tx) => {
    const definition = await tx.ruleDefinition.upsert({
      where: { institutionId_key: { institutionId: input.institutionId, key: KPI_REGISTRY_RULE_KEY } },
      update: {
        name: "KPI Controls",
        description: "Versioned presentation mapping from Admin KPI cards to BoardOps variables/formulas.",
        policyType: KPI_REGISTRY_POLICY_TYPE,
      },
      create: {
        institutionId: input.institutionId,
        key: KPI_REGISTRY_RULE_KEY,
        name: "KPI Controls",
        description: "Versioned presentation mapping from Admin KPI cards to BoardOps variables/formulas.",
        policyType: KPI_REGISTRY_POLICY_TYPE,
      },
    });

    const current = await tx.ruleVersion.findFirst({
      where: { ruleDefinitionId: definition.id, status: "ACTIVE" },
      orderBy: { version: "desc" },
    });
    const before = current ? parseStoredSnapshot(current) : defaultKpiSnapshot();
    const next: KpiConfigSnapshot = {
      schemaVersion: 1,
      items: { ...before.items, [input.key]: input.item },
    };
    const rulesJson = JSON.stringify(next);
    const checksum = sha256(rulesJson);
    const maxVersion = await tx.ruleVersion.aggregate({
      where: { ruleDefinitionId: definition.id },
      _max: { version: true },
    });
    const now = new Date();
    const versionNumber = (maxVersion._max.version ?? 0) + 1;

    if (current) {
      await tx.ruleVersion.updateMany({
        where: { ruleDefinitionId: definition.id, status: "ACTIVE" },
        data: { status: "HISTORICAL", effectiveUntil: new Date(now.getTime() - 1) },
      });
    }

    const created = await tx.ruleVersion.create({
      data: {
        ruleDefinitionId: definition.id,
        version: versionNumber,
        rulesJson,
        checksum,
        effectiveFrom: now,
        effectiveUntil: null,
        status: "ACTIVE",
        createdByUserId: input.adminUserId,
        reason: input.reason?.trim() || "Updated KPI presentation",
      },
    });

    await appendAudit(
      {
        institutionId: input.institutionId,
        actorUserId: input.adminUserId,
        actorRole: "ADMIN",
        action: "KPI_CONFIGURATION_UPDATED",
        entityType: "KPI_CONFIGURATION",
        entityId: created.id,
        requestId: input.requestId,
        reason: input.reason?.trim() || null,
        beforeSummary: JSON.stringify({ key: input.key, ...before.items[input.key] }),
        afterSummary: JSON.stringify({ key: input.key, ...input.item }),
        metadata: {
          key: input.key,
          surface: catalog.surface,
          nativeLabel: catalog.nativeLabel,
          configurationVersion: versionNumber,
          sourceVariableKey: input.item.sourceVariableKey,
        },
      },
      tx
    );

    return { snapshot: next, version: versionNumber, updatedAt: created.createdAt };
  });
}
