from pathlib import Path


def patch(path: str, old: str, new: str, label: str) -> None:
    file = Path(path)
    text = file.read_text()
    if new in text:
        return
    if text.count(old) != 1:
        raise SystemExit(f"{label}: expected one match, found {text.count(old)}")
    file.write_text(text.replace(old, new, 1))


approve_old = '''    const now = new Date();
    const updated = await tx.leaveRequest.update({
      where: { id: leave.id },
      data: {
        status: "APPROVED",
        reviewedAt: now,
        reviewedByUserId: ctx.user.id,
        reviewReason: body.reason ?? null,
      },
    });
'''
approve_new = '''    const now = new Date();
    const reviewReason = body.reason ?? null;
    const guard = await tx.leaveRequest.updateMany({
      where: {
        id: leave.id,
        institutionId: ctx.institutionId,
        status: "PENDING",
      },
      data: {
        status: "APPROVED",
        reviewedAt: now,
        reviewedByUserId: ctx.user.id,
        reviewReason,
      },
    });
    if (guard.count != 1) {
      throw new ApiError(
        CODES.RESOURCE_CHANGED,
        "This leave request was cancelled or reviewed just now. Refresh to see its latest state.",
        409
      );
    }
    const updated = { id: leave.id, status: "APPROVED", reviewedAt: now, reviewReason };
'''
patch(
    "src/app/api/v1/admin/leave-requests/[id]/approve/route.ts",
    approve_old,
    approve_new,
    "approve transition",
)

reject_old = '''    const now = new Date();
    const updated = await tx.leaveRequest.update({
      where: { id: leave.id },
      data: {
        status: "REJECTED",
        reviewedAt: now,
        reviewedByUserId: ctx.user.id,
        reviewReason: body.reason,
      },
    });
'''
reject_new = '''    const now = new Date();
    const guard = await tx.leaveRequest.updateMany({
      where: {
        id: leave.id,
        institutionId: ctx.institutionId,
        status: "PENDING",
      },
      data: {
        status: "REJECTED",
        reviewedAt: now,
        reviewedByUserId: ctx.user.id,
        reviewReason: body.reason,
      },
    });
    if (guard.count != 1) {
      throw new ApiError(
        CODES.RESOURCE_CHANGED,
        "This leave request was cancelled or reviewed just now. Refresh to see its latest state.",
        409
      );
    }
    const updated = { id: leave.id, status: "REJECTED", reviewedAt: now, reviewReason: body.reason };
'''
patch(
    "src/app/api/v1/admin/leave-requests/[id]/reject/route.ts",
    reject_old,
    reject_new,
    "reject transition",
)

print("Phase 23 leave review race guards applied")
