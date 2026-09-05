from pathlib import Path


def replace_once(text: str, old: str, new: str, label: str) -> str:
    if new in text:
        return text
    if text.count(old) != 1:
        raise SystemExit(f"{label}: expected exactly one match, found {text.count(old)}")
    return text.replace(old, new, 1)


# Resident DTO: CANCELLED is a real lifecycle state, not an arbitrary string.
types_path = Path("src/components/app/resident/_shared/types.ts")
types = types_path.read_text()
types = replace_once(
    types,
    '  status: "PENDING" | "APPROVED" | "REJECTED" | string;\n',
    '  status: "PENDING" | "APPROVED" | "REJECTED" | "CANCELLED" | string;\n',
    "LeaveRequestDto status",
)
types_path.write_text(types)


meals_path = Path("src/components/app/resident/meals.tsx")
text = meals_path.read_text()

text = replace_once(
    text,
    '  Utensils,\n  type LucideIcon,\n',
    '  Utensils,\n  X,\n  type LucideIcon,\n',
    "lucide X import",
)

text = replace_once(
    text,
    '  const [leaveOpen, setLeaveOpen] = useState(false);\n  const [flash, setFlash] = useState<Record<string, Flash>>({});\n',
    '  const [leaveOpen, setLeaveOpen] = useState(false);\n'
    '  const [leaveConfirmId, setLeaveConfirmId] = useState<string | null>(null);\n'
    '  const [cancellingLeaveId, setCancellingLeaveId] = useState<string | null>(null);\n'
    '  const [leaveActionError, setLeaveActionError] = useState<Record<string, string>>({});\n'
    '  const [flash, setFlash] = useState<Record<string, Flash>>({});\n',
    "leave cancellation state",
)

handler = '''\n  /* -------------------------- leave cancellation -------------------------- */\n\n  async function handleCancelLeave(leave: LeaveRequestDto) {\n    if (leave.status !== "PENDING" || cancellingLeaveId) return;\n\n    const snapshots = queryClient.getQueriesData<LeaveRequestDto[]>({\n      queryKey: ["api", RESIDENT_KEYS.leaveRequests],\n    });\n\n    setCancellingLeaveId(leave.id);\n    setLeaveActionError((current) => {\n      const next = { ...current };\n      delete next[leave.id];\n      return next;\n    });\n\n    // Optimistic lifecycle transition. A concurrent Admin review can still win;\n    // the catch path restores every cached copy before showing the server truth.\n    for (const [key] of snapshots) {\n      queryClient.setQueryData<LeaveRequestDto[]>(key, (old) =>\n        old?.map((row) => (row.id === leave.id ? { ...row, status: "CANCELLED" } : row))\n      );\n    }\n\n    try {\n      await apiJson<{ id: string; status: "CANCELLED" }>(\n        `/api/v1/leave-requests/${leave.id}/cancel`,\n        "POST",\n        {}\n      );\n      setLeaveConfirmId(null);\n      invalidate([RESIDENT_KEYS.leaveRequests, RESIDENT_KEYS.notifications]);\n    } catch (error) {\n      for (const [key, value] of snapshots) queryClient.setQueryData(key, value);\n      setLeaveActionError((current) => ({\n        ...current,\n        [leave.id]: friendlyError(error),\n      }));\n      if (error instanceof ApiClientError && error.code === "RESOURCE_CHANGED") {\n        invalidate([RESIDENT_KEYS.leaveRequests]);\n      }\n    } finally {\n      setCancellingLeaveId(null);\n    }\n  }\n'''

text = replace_once(
    text,
    '  /* ------------------------------- grouping -------------------------------- */\n',
    handler + '\n  /* ------------------------------- grouping -------------------------------- */\n',
    "leave cancellation handler",
)

old_block = '''          <div className="max-h-96 space-y-2.5 overflow-y-auto pr-1">\n            {leaves.map((l) => (\n              <div key={l.id} className="glass-inset hover:glass border border-border/40 rounded-2xl p-3.5 transition-all">\n                <div className="flex items-start justify-between gap-3">\n                  <div className="min-w-0">\n                    <p className="kpi-num text-sm font-semibold text-foreground">\n                      {l.startDate} → {l.endDate}\n                    </p>\n                    <p className="mt-0.5 truncate text-xs text-muted-foreground">{l.reason}</p>\n                  </div>\n                  <StatusBadge status={l.status} />\n                </div>\n                <p className="mt-1.5 text-xs text-muted-foreground">\n                  {l.preview.futureUnlockedMeals} future unlocked meals will turn off\n                  {l.preview.alreadyLockedMeals > 0\n                    ? `; ${l.preview.alreadyLockedMeals} locked meals stay unchanged`\n                    : ""}\n                  .\n                </p>\n                {l.status === "REJECTED" && l.reviewReason && (\n                  <p className="mt-1 text-xs font-medium text-danger">Reason: {l.reviewReason}</p>\n                )}\n              </div>\n            ))}\n          </div>\n'''

new_block = '''          <div className="max-h-96 space-y-2.5 overflow-y-auto pr-1">\n            <AnimatePresence initial={false} mode="popLayout">\n              {leaves.map((l) => (\n                <motion.div\n                  key={l.id}\n                  layout\n                  initial={{ opacity: 0, y: 6 }}\n                  animate={{ opacity: 1, y: 0 }}\n                  exit={{ opacity: 0, scale: 0.98 }}\n                  transition={SPRING_SNAPPY}\n                  className="glass-inset hover:glass rounded-2xl border border-border/40 p-3.5 transition-[border-color,box-shadow,background-color]"\n                >\n                  <div className="flex items-start justify-between gap-3">\n                    <div className="min-w-0">\n                      <p className="kpi-num text-sm font-semibold text-foreground">\n                        {l.startDate} → {l.endDate}\n                      </p>\n                      <p className="mt-0.5 truncate text-xs text-muted-foreground">{l.reason}</p>\n                    </div>\n                    <StatusBadge status={l.status} />\n                  </div>\n                  <p className="mt-1.5 text-xs text-muted-foreground">\n                    {l.status === "CANCELLED"\n                      ? "Cancelled before Admin review. No meal state was changed."\n                      : `${l.preview.futureUnlockedMeals} future unlocked meals will turn off${\n                          l.preview.alreadyLockedMeals > 0\n                            ? `; ${l.preview.alreadyLockedMeals} locked meals stay unchanged`\n                            : ""\n                        }.`}\n                  </p>\n                  {l.status === "REJECTED" && l.reviewReason && (\n                    <p className="mt-1 text-xs font-medium text-danger">Reason: {l.reviewReason}</p>\n                  )}\n\n                  <AnimatePresence initial={false} mode="wait">\n                    {l.status === "PENDING" && leaveConfirmId === l.id ? (\n                      <motion.div\n                        key="confirm-cancel"\n                        initial={{ opacity: 0, height: 0, y: -4 }}\n                        animate={{ opacity: 1, height: "auto", y: 0 }}\n                        exit={{ opacity: 0, height: 0, y: -4 }}\n                        transition={SPRING_SNAPPY}\n                        className="mt-3 flex flex-wrap items-center justify-end gap-2 overflow-hidden border-t border-border/30 pt-3"\n                      >\n                        <span className="mr-auto text-xs text-muted-foreground">Cancel this pending request?</span>\n                        <GlassButton\n                          size="sm"\n                          variant="ghost"\n                          disabled={cancellingLeaveId === l.id}\n                          onClick={() => setLeaveConfirmId(null)}\n                        >\n                          Keep\n                        </GlassButton>\n                        <GlassButton\n                          size="sm"\n                          variant="destructive"\n                          loading={cancellingLeaveId === l.id}\n                          onClick={() => void handleCancelLeave(l)}\n                        >\n                          Confirm cancel\n                        </GlassButton>\n                      </motion.div>\n                    ) : l.status === "PENDING" ? (\n                      <motion.div\n                        key="cancel-action"\n                        initial={{ opacity: 0 }}\n                        animate={{ opacity: 1 }}\n                        exit={{ opacity: 0 }}\n                        transition={{ duration: 0.16 }}\n                        className="mt-2 flex justify-end"\n                      >\n                        <GlassButton\n                          size="sm"\n                          variant="ghost"\n                          icon={<X />}\n                          onClick={() => setLeaveConfirmId(l.id)}\n                        >\n                          Cancel request\n                        </GlassButton>\n                      </motion.div>\n                    ) : null}\n                  </AnimatePresence>\n\n                  {leaveActionError[l.id] && (\n                    <motion.p\n                      initial={{ opacity: 0, y: -3 }}\n                      animate={{ opacity: 1, y: 0 }}\n                      className="mt-2 text-xs font-medium text-danger"\n                      role="alert"\n                    >\n                      {leaveActionError[l.id]}\n                    </motion.p>\n                  )}\n                </motion.div>\n              ))}\n            </AnimatePresence>\n          </div>\n'''

text = replace_once(text, old_block, new_block, "leave request history UI")
meals_path.write_text(text)

print("Phase 23 leave UI patch applied")
