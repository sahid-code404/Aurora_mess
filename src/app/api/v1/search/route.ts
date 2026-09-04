/**
 * GET /api/v1/search?q= — global search, authorization-aware (spec §76).
 * q: 2-60 chars. Grouped results, max 5 per group, computed in parallel.
 * ADMIN   → residents (name/email), payments (number/reference), bills
 *           (number), expenses (number/description), tasks (description).
 * RESIDENT → ONLY their own payments / bills / tasks / leave requests
 *           (numbers, references and descriptions). A resident can never
 *           discover another resident through search.
 */
import { z } from "zod";
import type { NextRequest } from "next/server";
import { db } from "@/lib/db";
import { route } from "@/lib/auth/guard";
import { ApiError, CODES } from "@/lib/errors";

const searchQuerySchema = z.object({
  q: z
    .string()
    .trim()
    .min(2, "Type at least 2 characters to search.")
    .max(60, "Search text is too long."),
});

function parseQuery<T>(
  schema: {
    safeParse: (
      v: unknown
    ) => { success: true; data: T } | { success: false; error: { issues: { path: (string | number | symbol)[]; message: string }[] } };
  },
  req: NextRequest
): T {
  const raw: Record<string, string> = {};
  req.nextUrl.searchParams.forEach((value, key) => {
    if (value !== "") raw[key] = value;
  });
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const fields: Record<string, string> = {};
    for (const issue of parsed.error.issues) {
      const key = issue.path.join(".") || "query";
      if (!fields[key]) fields[key] = issue.message;
    }
    throw new ApiError(CODES.VALIDATION_FAILED, "Please check the request parameters.", 400, fields);
  }
  return parsed.data;
}

const GROUP_LIMIT = 5;

export const GET = route({ auth: "ANY" }, async (ctx) => {
  const query = parseQuery(searchQuerySchema, ctx.req);
  const q = query.q;

  if (ctx.user.role === "ADMIN") {
    const [residents, payments, bills, expenses, tasks] = await Promise.all([
      db.user.findMany({
        where: {
          institutionId: ctx.institutionId,
          role: "RESIDENT",
          OR: [{ email: { contains: q } }, { profile: { fullName: { contains: q } } }],
        },
        orderBy: { createdAt: "desc" },
        take: GROUP_LIMIT,
        select: {
          id: true,
          email: true,
          status: true,
          profile: { select: { fullName: true } },
        },
      }),
      db.payment.findMany({
        where: {
          institutionId: ctx.institutionId,
          OR: [{ displayNumber: { contains: q } }, { reference: { contains: q } }],
        },
        orderBy: { submittedAt: "desc" },
        take: GROUP_LIMIT,
        select: {
          id: true,
          displayNumber: true,
          amountMinor: true,
          status: true,
          residentId: true,
          submittedAt: true,
        },
      }),
      db.bill.findMany({
        where: { institutionId: ctx.institutionId, billNumber: { contains: q } },
        orderBy: { generatedAt: "desc" },
        take: GROUP_LIMIT,
        select: {
          id: true,
          billNumber: true,
          totalDueMinor: true,
          status: true,
          residentId: true,
          dueDate: true,
        },
      }),
      db.expense.findMany({
        where: {
          institutionId: ctx.institutionId,
          OR: [{ displayNumber: { contains: q } }, { description: { contains: q } }],
        },
        orderBy: { date: "desc" },
        take: GROUP_LIMIT,
        select: {
          id: true,
          displayNumber: true,
          totalMinor: true,
          status: true,
          date: true,
        },
      }),
      db.task.findMany({
        where: { institutionId: ctx.institutionId, description: { contains: q } },
        orderBy: { createdAt: "desc" },
        take: GROUP_LIMIT,
        select: {
          id: true,
          description: true,
          status: true,
          assignedResidentId: true,
          dueDate: true,
        },
      }),
    ]);

    return {
      data: {
        query: q,
        groups: {
          residents: residents.map((r) => ({
            id: r.id,
            fullName: r.profile?.fullName ?? r.email,
            email: r.email,
            status: r.status,
          })),
          payments,
          bills,
          expenses,
          tasks,
        },
      },
    };
  }

  // RESIDENT — own data only, never another resident's (spec §76).
  const [payments, bills, tasks, leave] = await Promise.all([
    db.payment.findMany({
      where: {
        institutionId: ctx.institutionId,
        residentId: ctx.user.id,
        OR: [{ displayNumber: { contains: q } }, { reference: { contains: q } }],
      },
      orderBy: { submittedAt: "desc" },
      take: GROUP_LIMIT,
      select: {
        id: true,
        displayNumber: true,
        amountMinor: true,
        status: true,
        submittedAt: true,
      },
    }),
    db.bill.findMany({
      where: { institutionId: ctx.institutionId, residentId: ctx.user.id, billNumber: { contains: q } },
      orderBy: { generatedAt: "desc" },
      take: GROUP_LIMIT,
      select: {
        id: true,
        billNumber: true,
        totalDueMinor: true,
        status: true,
        dueDate: true,
      },
    }),
    db.task.findMany({
      where: {
        institutionId: ctx.institutionId,
        assignedResidentId: ctx.user.id,
        description: { contains: q },
      },
      orderBy: { createdAt: "desc" },
      take: GROUP_LIMIT,
      select: {
        id: true,
        description: true,
        status: true,
        dueDate: true,
      },
    }),
    db.leaveRequest.findMany({
      where: {
        institutionId: ctx.institutionId,
        residentId: ctx.user.id,
        reason: { contains: q },
      },
      orderBy: { createdAt: "desc" },
      take: GROUP_LIMIT,
      select: {
        id: true,
        startDate: true,
        endDate: true,
        status: true,
        reason: true,
      },
    }),
  ]);

  return { data: { query: q, groups: { payments, bills, tasks, leave } } };
});
