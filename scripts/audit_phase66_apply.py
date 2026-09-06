from pathlib import Path


def replace(path: str, old: str, new: str, count: int = 1) -> None:
    p = Path(path)
    text = p.read_text()
    actual = text.count(old)
    if actual != count:
        raise SystemExit(f"{path}: expected {count} occurrences, found {actual}: {old!r}")
    p.write_text(text.replace(old, new, count))

replace(
    "prisma/schema.prisma",
    '  status        String   @default("ACTIVE") // ACTIVE | ARCHIVED\n  createdAt     DateTime @default(now())\n  updatedAt     DateTime @updatedAt\n\n  versions RuleVersion[]\n',
    '  createdAt     DateTime @default(now())\n  updatedAt     DateTime @updatedAt\n\n  versions RuleVersion[]\n',
)
replace(
    "src/lib/domain/rules/deficit-rules.ts",
    '      policyType: DEFICIT_POLICY_TYPE,\n      status: "ACTIVE",\n',
    '      policyType: DEFICIT_POLICY_TYPE,\n',
)
replace(
    "src/app/api/v1/admin/rules/deficit/route.ts",
    '            policyType: overview.definition.policyType,\n            status: overview.definition.status,\n',
    '            policyType: overview.definition.policyType,\n',
)

settings = "src/components/app/admin/settings.tsx"
replace(settings, '  Banknote,\n  Building2,\n  Check,\n', '  Archive,\n  Banknote,\n  Building2,\n  Check,\n')
replace(settings, '  Plus,\n  ScrollText,\n  Utensils,\n', '  Plus,\n  RotateCcw,\n  ScrollText,\n  Utensils,\n')
replace(
    settings,
    'import { GlassButton } from "@/components/glass/GlassButton";\n',
    'import { GlassButton } from "@/components/glass/GlassButton";\nimport { ConfirmDialog } from "@/components/glass/ConfirmDialog";\n',
)
replace(
    settings,
    '  const policiesQuery = useApiQuery<PolicyRow[]>(POLICIES_PATH);\n  const [policyFormOpen, setPolicyFormOpen] = useState(false);\n',
    '  const policiesQuery = useApiQuery<PolicyRow[]>(POLICIES_PATH);\n  const [policyFormOpen, setPolicyFormOpen] = useState(false);\n  const [policyAction, setPolicyAction] = useState<{ policy: PolicyRow; action: "ARCHIVE" | "REACTIVATE" } | null>(null);\n  const [policyActionSaving, setPolicyActionSaving] = useState(false);\n',
)
replace(
    settings,
    '              <CollapseRow key={p.id} label={`${p.title} · v${p.latestVersion?.version ?? 1}`}>\n                <p className="whitespace-pre-wrap text-[12px] leading-relaxed text-muted-foreground">{p.content}</p>\n',
    '              <CollapseRow\n                key={p.id}\n                label={`${p.title} · v${p.latestVersion?.version ?? 1}${p.status === "ARCHIVED" ? " · Archived" : ""}`}\n              >\n                <div className="mb-3 flex flex-wrap items-center justify-between gap-2">\n                  <span className={cn(\n                    "rounded-pill px-2 py-1 text-[10px] font-semibold uppercase tracking-wide",\n                    p.status === "ARCHIVED" ? "bg-muted text-muted-foreground" : "bg-success/12 text-success"\n                  )}>\n                    {p.status === "ARCHIVED" ? "Archived" : "Active"}\n                  </span>\n                  <GlassButton\n                    variant="ghost"\n                    size="sm"\n                    icon={p.status === "ARCHIVED" ? <RotateCcw /> : <Archive />}\n                    onClick={() => setPolicyAction({ policy: p, action: p.status === "ARCHIVED" ? "REACTIVATE" : "ARCHIVE" })}\n                  >\n                    {p.status === "ARCHIVED" ? "Reactivate" : "Archive"}\n                  </GlassButton>\n                </div>\n                <p className="whitespace-pre-wrap text-[12px] leading-relaxed text-muted-foreground">{p.content}</p>\n',
)
replace(
    settings,
    '      {policyFormOpen && (\n        <PolicyPublishDialog\n          open\n          onOpenChange={setPolicyFormOpen}\n          policies={policiesQuery.data ?? []}\n          onSaved={() => invalidate([POLICIES_PATH])}\n        />\n      )}\n    </StaggerGroup>\n',
    '      {policyFormOpen && (\n        <PolicyPublishDialog\n          open\n          onOpenChange={setPolicyFormOpen}\n          policies={policiesQuery.data ?? []}\n          onSaved={() => invalidate([POLICIES_PATH])}\n        />\n      )}\n\n      {policyAction && (\n        <ConfirmDialog\n          open\n          onOpenChange={(open) => {\n            if (!open && !policyActionSaving) setPolicyAction(null);\n          }}\n          title={policyAction.action === "ARCHIVE" ? `Archive ${policyAction.policy.title}?` : `Reactivate ${policyAction.policy.title}?`}\n          description={\n            policyAction.action === "ARCHIVE"\n              ? "New registrations will no longer be asked to accept this policy. Existing version history and resident acceptances stay intact."\n              : "This policy’s latest published version will become active for new registrations again."\n          }\n          confirmLabel={policyAction.action === "ARCHIVE" ? "Archive policy" : "Reactivate policy"}\n          tone={policyAction.action === "ARCHIVE" ? "destructive" : "primary"}\n          requireReason\n          reasonPlaceholder="Reason for this policy lifecycle change"\n          loading={policyActionSaving}\n          onConfirm={async (reason) => {\n            if (!reason) return;\n            setPolicyActionSaving(true);\n            try {\n              const action = policyAction.action === "ARCHIVE" ? "archive" : "reactivate";\n              await postJson(`${POLICIES_PATH}/${policyAction.policy.id}/${action}`, { reason });\n              invalidate([POLICIES_PATH]);\n              toast.success(policyAction.action === "ARCHIVE" ? "Policy archived" : "Policy reactivated");\n              setPolicyAction(null);\n            } catch (err) {\n              toast.error(errMessage(err));\n            } finally {\n              setPolicyActionSaving(false);\n            }\n          }}\n        />\n      )}\n    </StaggerGroup>\n',
)

# Fail closed if the removed RuleDefinition state is still referenced by production code.
for path in ["prisma/schema.prisma", "src/lib/domain/rules/deficit-rules.ts", "src/app/api/v1/admin/rules/deficit/route.ts"]:
    text = Path(path).read_text()
    if path != "prisma/schema.prisma" and "definition.status" in text:
        raise SystemExit(f"dead RuleDefinition status remains in {path}")
