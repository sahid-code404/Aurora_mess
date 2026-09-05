from pathlib import Path


def replace_once(path: str, old: str, new: str) -> None:
    p = Path(path)
    text = p.read_text()
    if new in text:
        return
    if old not in text:
        raise SystemExit(f"expected pattern missing in {path}: {old[:160]!r}")
    p.write_text(text.replace(old, new, 1))


# ---------------------------------------------------------------------------
# Backend assignment/rejection wording + invariant
# ---------------------------------------------------------------------------
replace_once(
    "src/app/api/v1/admin/tasks/route.ts",
    """  const result = await db.$transaction(async (tx) => {\n""",
    """  if (body.taskType === \"GENERAL\" && (estimatedAmountMinor !== null || itemLines.length > 0)) {\n    throw new ApiError(\n      CODES.VALIDATION_FAILED,\n      \"Normal Tasks cannot include purchase budgets or item-price lines.\",\n      400,\n      { items: \"Use a Market Task when money or purchased items are involved.\" }\n    );\n  }\n\n  const result = await db.$transaction(async (tx) => {\n""",
)
replace_once(
    "src/app/api/v1/admin/tasks/route.ts",
    """        title: \"Market task assigned\",\n        message: `New task assigned: \"${task.description}\"${body.dueDate ? ` — due ${body.dueDate}` : \"\"}.`,\n""",
    """        title: task.taskType === \"GENERAL\" ? \"Normal task assigned\" : \"Market task assigned\",\n        message:\n          task.taskType === \"GENERAL\"\n            ? `New Normal Task assigned: \"${task.description}\"${body.dueDate ? ` — due ${body.dueDate}` : \"\"}.`\n            : `New Market Task assigned: \"${task.description}\"${body.dueDate ? ` — due ${body.dueDate}` : \"\"}.`,\n""",
)

replace_once(
    "src/app/api/v1/admin/task-submissions/[id]/reject/route.ts",
    """        title: \"Submission rejected\",\n        message: `Your submission for \"${submission.task.description}\" was rejected. Reason: ${body.reason}`,\n""",
    """        title:\n          submission.task.taskType === \"GENERAL\"\n            ? \"Normal task completion rejected\"\n            : \"Market task submission rejected\",\n        message:\n          submission.task.taskType === \"GENERAL\"\n            ? `Your completion for \"${submission.task.description}\" was rejected. Reason: ${body.reason}`\n            : `Your purchase submission for \"${submission.task.description}\" was rejected. Reason: ${body.reason}`,\n""",
)
replace_once(
    "src/app/api/v1/admin/task-submissions/[id]/reject/route.ts",
    """      reason: `Task purchase submission rejected by admin: ${body.reason}`,\n""",
    """      reason:\n        submission.task.taskType === \"GENERAL\"\n          ? `Normal task completion rejected by admin: ${body.reason}`\n          : `Market task purchase rejected by admin: ${body.reason}`,\n""",
)

# ---------------------------------------------------------------------------
# Resident UI: Normal Task completion dialog + type-aware actions/copy
# ---------------------------------------------------------------------------
resident_path = "src/components/app/resident/tasks.tsx"
insert_marker = """/* ---------------------------- task progress stepper --------------------------- */\n"""
general_dialog = r'''function GeneralCompletionDialog({
  task,
  open,
  onOpenChange,
}: {
  task: TaskDto;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const invalidate = useInvalidateResident();
  const [comment, setComment] = useState("");
  const [proof, setProof] = useState<File | null>(null);
  const [proofError, setProofError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    setSubmitting(true);
    setError(null);
    try {
      const form = new FormData();
      if (comment.trim()) form.set("comment", comment.trim());
      if (proof) form.set("proof", proof);
      await apiMultipart(`/api/v1/tasks/${task.id}/submission`, form);
      invalidate([RESIDENT_KEYS.tasks, RESIDENT_KEYS.dashboard, RESIDENT_KEYS.notifications]);
      broadcastNotification("task_submitted");
      toast.success("Completion submitted — waiting for admin verification", {
        description: "Normal Tasks never create a mess expense or ledger entry.",
      });
      onOpenChange(false);
    } catch (err) {
      setError(friendlyError(err, "We couldn't submit this completion. Please try again."));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <SheetDialog
      open={open}
      onOpenChange={(next) => {
        if (!submitting) onOpenChange(next);
      }}
      title="Submit completion"
      description={`"${task.description}" — tell the admin the work is done. No purchase or expense is created.`}
      footer={
        <SheetFooterActions onCancel={() => onOpenChange(false)}>
          <GlassButton loading={submitting} disabled={Boolean(proofError) || submitting} onClick={() => void submit()}>
            Submit completion
          </GlassButton>
        </SheetFooterActions>
      }
    >
      <div className="space-y-4">
        <div className="rounded-2xl border border-primary/25 bg-primary/5 p-3.5 text-xs text-muted-foreground">
          <p className="font-semibold text-foreground">Normal Task · non-financial</p>
          <p className="mt-1 leading-relaxed">
            This completion goes to the Admin for verification. It cannot create an Expense or change the ledger.
          </p>
        </div>
        <GlassField label="Completion note (optional)" hint="Briefly describe what you completed.">
          <GlassTextarea
            value={comment}
            maxLength={500}
            placeholder="e.g. Filled and placed the water container in the kitchen"
            onChange={(e) => setComment(e.target.value)}
          />
        </GlassField>
        <FileProofInput
          file={proof}
          error={proofError}
          onFile={(file) => {
            setProofError(file ? proofProblems(file) : null);
            setProof(file);
          }}
        />
        {error && (
          <p role="alert" className="glass-inset rounded-md px-3 py-2 text-xs font-medium text-danger">
            {error}
          </p>
        )}
      </div>
    </SheetDialog>
  );
}

'''
replace_once(resident_path, insert_marker, general_dialog + insert_marker)

replace_once(
    resident_path,
    """  const TaskIcon = task.taskType === \"MARKET_PURCHASE\" ? ShoppingCart : ClipboardList;\n  const orbColor = taskOrbColor(task.status);\n""",
    """  const isMarketTask = task.taskType === \"MARKET_PURCHASE\";\n  const TaskIcon = isMarketTask ? ShoppingCart : ClipboardList;\n  const orbColor = taskOrbColor(task.status);\n""",
)
replace_once(
    resident_path,
    """              <ShoppingCart className=\"size-4 text-primary shrink-0 mt-0.5\" />\n              <div>\n                <p className=\"font-semibold text-primary\">Ready to Execute</p>\n                <p className=\"text-muted-foreground mt-0.5\">\n                  You accepted this task. When you are ready, click <strong>Start Submission</strong> to begin recording your purchase and receipt.\n                </p>\n              </div>\n""",
    """              {isMarketTask ? (\n                <ShoppingCart className=\"size-4 text-primary shrink-0 mt-0.5\" />\n              ) : (\n                <ClipboardList className=\"size-4 text-primary shrink-0 mt-0.5\" />\n              )}\n              <div>\n                <p className=\"font-semibold text-primary\">Ready to Execute</p>\n                <p className=\"text-muted-foreground mt-0.5\">\n                  {isMarketTask ? (\n                    <>You accepted this Market Task. Click <strong>Start Task</strong> when you begin shopping; submit the purchase after the work is done.</>\n                  ) : (\n                    <>You accepted this Normal Task. Click <strong>Start Task</strong> when you begin, then submit completion for Admin verification.</>\n                  )}\n                </p>\n              </div>\n""",
)
replace_once(
    resident_path,
    """                icon={<ShoppingCart className=\"size-3.5\" />}\n                loading={busy}\n                onClick={() => {\n                  onClose();\n                  onStart(task);\n                }}\n              >\n                Start Submission\n""",
    """                icon={isMarketTask ? <ShoppingCart className=\"size-3.5\" /> : <ClipboardList className=\"size-3.5\" />}\n                loading={busy}\n                onClick={() => {\n                  onClose();\n                  onStart(task);\n                }}\n              >\n                Start Task\n""",
)
replace_once(
    resident_path,
    """                icon={<ShoppingCart className=\"size-3.5\" />}\n                onClick={() => {\n                  onClose();\n                  onSubmitPurchase(task);\n                }}\n              >\n                Submit Purchase\n""",
    """                icon={isMarketTask ? <ShoppingCart className=\"size-3.5\" /> : <CheckCircle2 className=\"size-3.5\" />}\n                onClick={() => {\n                  onClose();\n                  onSubmitPurchase(task);\n                }}\n              >\n                {isMarketTask ? \"Submit Purchase\" : \"Submit Completion\"}\n""",
)
replace_once(
    resident_path,
    """      if (action === \"start\") toast.success(`Task started — you can submit your purchase any time.`);\n""",
    """      if (action === \"start\")\n        toast.success(\n          task.taskType === \"MARKET_PURCHASE\"\n            ? \"Market Task started — submit the purchase when shopping is complete.\"\n            : \"Normal Task started — submit completion when the work is done.\"\n        );\n""",
)
replace_once(
    resident_path,
    """                                      icon={<ShoppingCart className=\"size-3\" />}\n                                      onClick={() => void transition(task, \"start\")}\n                                    >\n                                      Start\n""",
    """                                      icon={task.taskType === \"MARKET_PURCHASE\" ? <ShoppingCart className=\"size-3\" /> : <ClipboardList className=\"size-3\" />}\n                                      onClick={() => void transition(task, \"start\")}\n                                    >\n                                      Start\n""",
)
replace_once(
    resident_path,
    """                                      icon={<ShoppingCart className=\"size-3\" />}\n                                      onClick={() => setSubmitTask(task)}\n                                    >\n                                      Submit purchase\n""",
    """                                      icon={task.taskType === \"MARKET_PURCHASE\" ? <ShoppingCart className=\"size-3\" /> : <CheckCircle2 className=\"size-3\" />}\n                                      onClick={() => setSubmitTask(task)}\n                                    >\n                                      {task.taskType === \"MARKET_PURCHASE\" ? \"Submit purchase\" : \"Submit completion\"}\n""",
)
replace_once(
    resident_path,
    """      {/* Purchase submission dialog */}\n      {submitTask ? (\n        <SubmissionDialog\n          key={submitTask.id}\n          task={submitTask}\n          open\n          onOpenChange={(open) => {\n            if (!open) setSubmitTask(null);\n          }}\n        />\n      ) : null}\n""",
    """      {/* Task submission dialog — purchase details only exist for Market Tasks. */}\n      {submitTask ? (\n        submitTask.taskType === \"GENERAL\" ? (\n          <GeneralCompletionDialog\n            key={submitTask.id}\n            task={submitTask}\n            open\n            onOpenChange={(open) => {\n              if (!open) setSubmitTask(null);\n            }}\n          />\n        ) : (\n          <SubmissionDialog\n            key={submitTask.id}\n            task={submitTask}\n            open\n            onOpenChange={(open) => {\n              if (!open) setSubmitTask(null);\n            }}\n          />\n        )\n      ) : null}\n""",
)

# Resident submission detail labels: don't present a Normal Task as a purchase.
replace_once(
    resident_path,
    """                <ShoppingCart className=\"size-3.5 text-primary\" /> Purchase Submission Details\n""",
    """                {isMarketTask ? (\n                  <ShoppingCart className=\"size-3.5 text-primary\" />\n                ) : (\n                  <ClipboardList className=\"size-3.5 text-primary\" />\n                )}\n                {isMarketTask ? \"Purchase Submission Details\" : \"Completion Details\"}\n""",
)
replace_once(
    resident_path,
    """                <KeyValueRow\n                  label=\"Claimed Total\"\n                  value={<Money minor={sub.claimedTotalMinor} className=\"font-bold text-foreground text-sm\" />}\n                />\n""",
    """                {isMarketTask && (\n                  <KeyValueRow\n                    label=\"Claimed Total\"\n                    value={<Money minor={sub.claimedTotalMinor} className=\"font-bold text-foreground text-sm\" />}\n                  />\n                )}\n""",
)
replace_once(
    resident_path,
    """                    <span className=\"text-muted-foreground block font-medium mb-0.5\">Your comment:</span>\n""",
    """                    <span className=\"text-muted-foreground block font-medium mb-0.5\">\n                      {isMarketTask ? \"Your comment:\" : \"Completion note:\"}\n                    </span>\n""",
)
replace_once(
    resident_path,
    """                    <Paperclip className=\"size-3.5 text-primary\" /> Attached Receipt / Bill Proof\n""",
    """                    <Paperclip className=\"size-3.5 text-primary\" /> {isMarketTask ? \"Attached Receipt / Bill Proof\" : \"Completion Proof\"}\n""",
)

# ---------------------------------------------------------------------------
# Admin UI: type-aware review; Normal approval must never promise an expense.
# ---------------------------------------------------------------------------
admin_ui = "src/components/app/admin/tasks.tsx"
replace_once(
    admin_ui,
    """                <KeyValue label=\"Claimed total\" value={<Money minor={sub.claimedTotalMinor} className=\"font-bold text-foreground\" />} />\n""",
    """                {currentTask.taskType === \"MARKET_PURCHASE\" && (\n                  <KeyValue label=\"Claimed total\" value={<Money minor={sub.claimedTotalMinor} className=\"font-bold text-foreground\" />} />\n                )}\n""",
)
replace_once(
    admin_ui,
    """                  <p className=\"text-xs text-muted-foreground mb-1.5 font-medium\">Proof of purchase</p>\n""",
    """                  <p className=\"text-xs text-muted-foreground mb-1.5 font-medium\">\n                    {currentTask.taskType === \"MARKET_PURCHASE\" ? \"Proof of purchase\" : \"Completion proof\"}\n                  </p>\n""",
)
replace_once(
    admin_ui,
    """              ? `Approve ${currentTask.residentName}'s purchase of ${sub ? fmtMinor(sub.claimedTotalMinor) : \"\"}? An expense will be created and posted.`\n""",
    """              ? currentTask.taskType === \"MARKET_PURCHASE\"\n                ? `Approve ${currentTask.residentName}'s purchase of ${sub ? fmtMinor(sub.claimedTotalMinor) : \"\"}? An expense will be created and posted.`\n                : `Approve ${currentTask.residentName}'s Normal Task completion? No expense or ledger entry will be created.`\n""",
)
replace_once(
    admin_ui,
    """          confirmLabel={confirm === \"approve\" ? \"Approve & post expense\" : \"Reject submission\"}\n""",
    """          confirmLabel={\n            confirm === \"approve\"\n              ? currentTask.taskType === \"MARKET_PURCHASE\"\n                ? \"Approve & post expense\"\n                : \"Approve completion\"\n              : \"Reject submission\"\n          }\n""",
)
replace_once(
    admin_ui,
    """      toast.success(kind === \"approve\" ? \"Expense created and posted\" : \"Submission rejected\", {\n""",
    """      toast.success(\n        kind === \"approve\"\n          ? task.taskType === \"MARKET_PURCHASE\"\n            ? \"Expense created and posted\"\n            : \"Normal task completion approved\"\n          : \"Submission rejected\",\n        {\n""",
)
replace_once(
    admin_ui,
    """        description: `${task.residentName} · ${task.description}`,\n      });\n""",
    """          description: `${task.residentName} · ${task.description}`,\n        }\n      );\n""",
)
replace_once(
    admin_ui,
    """      {/* items */}\n      <div className=\"glass-inset rounded-md p-3\">\n        <div className=\"space-y-1\">\n          {sub.items.map((item) => (\n            <div key={item.id} className=\"flex items-center justify-between gap-3 text-[13px]\">\n              <span className=\"min-w-0 truncate\">\n                <span className=\"font-medium\">{item.itemName}</span>\n                <span className=\"kpi-num text-muted-foreground\">\n                  {\" \"}\n                  · {item.quantity} {item.unit ?? \"unit\"} × <Money minor={item.unitPriceMinor} plain />\n                </span>\n              </span>\n              <Money minor={item.lineTotalMinor} className=\"shrink-0 font-semibold\" />\n            </div>\n          ))}\n        </div>\n        <div className=\"mt-2 flex items-center justify-between border-t border-border/50 pt-2 text-sm font-semibold\">\n          <span>Claimed total</span>\n          <Money minor={sub.claimedTotalMinor} />\n        </div>\n      </div>\n""",
    """      {task.taskType === \"MARKET_PURCHASE\" ? (\n        <div className=\"glass-inset rounded-md p-3\">\n          <div className=\"space-y-1\">\n            {sub.items.map((item) => (\n              <div key={item.id} className=\"flex items-center justify-between gap-3 text-[13px]\">\n                <span className=\"min-w-0 truncate\">\n                  <span className=\"font-medium\">{item.itemName}</span>\n                  <span className=\"kpi-num text-muted-foreground\">\n                    {\" \"}\n                    · {item.quantity} {item.unit ?? \"unit\"} × <Money minor={item.unitPriceMinor} plain />\n                  </span>\n                </span>\n                <Money minor={item.lineTotalMinor} className=\"shrink-0 font-semibold\" />\n              </div>\n            ))}\n          </div>\n          <div className=\"mt-2 flex items-center justify-between border-t border-border/50 pt-2 text-sm font-semibold\">\n            <span>Claimed total</span>\n            <Money minor={sub.claimedTotalMinor} />\n          </div>\n        </div>\n      ) : (\n        <div className=\"glass-inset rounded-md p-3 text-[12px] text-muted-foreground\">\n          <p className=\"font-semibold text-foreground\">Normal Task completion · non-financial</p>\n          <p className=\"mt-1\">Approve after verifying the work. No Expense or ledger entry will be created.</p>\n        </div>\n      )}\n""",
)
replace_once(
    admin_ui,
    """          Approve & post expense\n""",
    """          {task.taskType === \"MARKET_PURCHASE\" ? \"Approve & post expense\" : \"Approve completion\"}\n""",
)
replace_once(
    admin_ui,
    """            confirm === \"approve\" ? (\n              <>\n                An official expense is created from these items (totals recomputed server-side), the money is posted to\n                the ledger, and {task.residentName} is notified. Duplicate posting is impossible — the submission links\n                to exactly one expense.\n                <span className=\"mt-2 block font-medium\">\n                  {task.description} · claimed <Money minor={sub.claimedTotalMinor} />\n                </span>\n              </>\n            ) : (\n""",
    """            confirm === \"approve\" ? (\n              task.taskType === \"MARKET_PURCHASE\" ? (\n                <>\n                  An official expense is created from these items (totals recomputed server-side), the money is posted to\n                  the ledger, and {task.residentName} is notified. Duplicate posting is impossible — the submission links\n                  to exactly one expense.\n                  <span className=\"mt-2 block font-medium\">\n                    {task.description} · claimed <Money minor={sub.claimedTotalMinor} />\n                  </span>\n                </>\n              ) : (\n                <>\n                  Approve this Normal Task completion after verifying the work. No Expense or ledger entry is created.\n                  <span className=\"mt-2 block font-medium\">{task.description}</span>\n                </>\n              )\n            ) : (\n""",
)
replace_once(
    admin_ui,
    """        items: items\n          .filter((i) => i.itemName.trim() !== \"\" || i.estimatedUnitPrice.trim() !== \"\")\n          .map((i) => ({\n            itemName: i.itemName.trim(),\n            expectedQuantity: Number(i.expectedQuantity),\n            unit: i.unit.trim() || undefined,\n            estimatedUnitPriceMinor: i.estimatedUnitPrice.trim() || undefined,\n          })),\n""",
    """        items:\n          taskType === \"GENERAL\"\n            ? []\n            : items\n                .filter((i) => i.itemName.trim() !== \"\" || i.estimatedUnitPrice.trim() !== \"\")\n                .map((i) => ({\n                  itemName: i.itemName.trim(),\n                  expectedQuantity: Number(i.expectedQuantity),\n                  unit: i.unit.trim() || undefined,\n                  estimatedUnitPriceMinor: i.estimatedUnitPrice.trim() || undefined,\n                })),\n""",
)

# ---------------------------------------------------------------------------
# Production cross-role smoke: prove Normal Task completes with zero money.
# ---------------------------------------------------------------------------
flow = "tests/seeded-business-flow-smoke.py"
replace_once(
    flow,
    """    check(resident.post(f\"/api/v1/tasks/{general_id}/accept\").data.get(\"status\") == \"ACCEPTED\", \"GENERAL task accept failed\")\n    check(resident.post(f\"/api/v1/tasks/{general_id}/start\").data.get(\"status\") == \"IN_PROGRESS\", \"GENERAL task start failed\")\n\n    market_description = f\"Phase19 market rice purchase {suffix}\"\n""",
    """    check(resident.post(f\"/api/v1/tasks/{general_id}/accept\").data.get(\"status\") == \"ACCEPTED\", \"GENERAL task accept failed\")\n    check(resident.post(f\"/api/v1/tasks/{general_id}/start\").data.get(\"status\") == \"IN_PROGRESS\", \"GENERAL task start failed\")\n\n    # Normal Tasks reject purchase data, submit zero money, and require Admin verification.\n    resident.post_form(\n        f\"/api/v1/tasks/{general_id}/submission\",\n        {\n            \"comment\": \"invalid purchase payload on normal task\",\n            \"itemsJson\": json.dumps([{\"itemName\": \"should fail\", \"quantity\": 1, \"unitPrice\": \"1.00\"}]),\n        },\n        expected=400,\n    )\n    general_submission = resident.post_form(\n        f\"/api/v1/tasks/{general_id}/submission\",\n        {\"comment\": \"Water container checked and filled for Phase 22 acceptance\"},\n    ).data or {}\n    check(general_submission.get(\"status\") == \"SUBMITTED\", \"GENERAL task completion did not reach SUBMITTED\")\n    check(general_submission.get(\"claimedTotalMinor\") == 0, \"GENERAL task completion carried money\")\n    check((general_submission.get(\"items\") or []) == [], \"GENERAL task completion created purchase lines\")\n    general_submission_id = general_submission.get(\"id\")\n    general_approved = admin.post(\n        f\"/api/v1/admin/task-submissions/{general_submission_id}/approve\",\n        {\"reason\": \"Phase 22 normal task verified\"},\n    ).data or {}\n    check(general_approved.get(\"status\") == \"APPROVED\", \"GENERAL task approval failed\")\n    check(general_approved.get(\"totalMinor\") == 0, \"GENERAL task approval produced a financial total\")\n    check(general_approved.get(\"expenseId\") is None, \"GENERAL task approval created an Expense\")\n    check(general_approved.get(\"journalId\") is None, \"GENERAL task approval created a journal\")\n\n    market_description = f\"Phase19 market rice purchase {suffix}\"\n""",
)
replace_once(
    flow,
    """    check(by_description.get(general_description, {}).get(\"status\") == \"IN_PROGRESS\", \"GENERAL task was not independently preserved\")\n""",
    """    check(by_description.get(general_description, {}).get(\"status\") == \"APPROVED\", \"GENERAL task did not complete independently\")\n    general_task_after = by_description.get(general_description, {})\n    check((general_task_after.get(\"submission\") or {}).get(\"expenseId\") is None, \"GENERAL task gained an expense link\")\n""",
)

print("Phase 22 task lifecycle patch applied")
