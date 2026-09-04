/**
 * DEVELOPMENT SEED — Aurora Residency Mess (spec §191).
 * Deterministic, obviously-development data. Never run against production.
 *
 * Time anchors: everything is relative to NOW in the institution timezone
 * (Asia/Kolkata). The previous month is fully BILLED; the current month is OPEN.
 *
 * Run: bun scripts/seed.ts
 */
import { PrismaClient } from "@prisma/client";
import { hashPassword } from "../src/lib/auth/password";
import {
  partsInTz,
  dateKeyInTz,
  computeCutoffAt,
  computeServiceWindow,
  localDateMidnightUtc,
  monthBoundsInTz,
  addDaysToKey,
} from "../src/lib/time";

const db = new PrismaClient();
const TZ = "Asia/Kolkata";

const now = new Date();
const todayKey = dateKeyInTz(now, TZ);
const cur = monthBoundsInTz(now, TZ); // { year, month, startKey, endKey }
const prevMonthDate = new Date(now.getTime() - 28 * 24 * 3600 * 1000);
const prev = monthBoundsInTz(prevMonthDate, TZ);
const daysInMonth = (startKey: string, endKey: string): string[] => {
  const out: string[] = [];
  let k = startKey;
  while (k <= endKey) {
    out.push(k);
    k = addDaysToKey(k, 1);
  }
  return out;
};
const prevDays = daysInMonth(prev.startKey, prev.endKey);
const curDays = daysInMonth(cur.startKey, cur.endKey).filter((k) => k <= addDaysToKey(todayKey, 2));

const ADMIN_EMAIL = "admin@messtest.in";
const RESIDENT_PASSWORD = "Resident#12345";
const ADMIN_PASSWORD = "Admin#12345";

async function wipe() {
  // FK-safe order (children first).
  const tables = [
    "policyExemption", "passwordResetToken", "idempotencyRecord", "deletionRequest", "outboxEvent",
    "notification", "announcement", "taskSubmissionItem", "taskSubmission", "taskItem", "task",
    "billAdjustment", "billLine", "bill", "billingSnapshot", "billingPeriod",
    "formulaVersion", "formulaDefinition",
    "ledgerEntry", "ledgerJournal", "ledgerAccount",
    "refund", "paymentStatusHistory", "payment", "expenseItem", "expense", "expenseCategory",
    "guestMealRequest", "residentMeal", "mealInstance", "mealDefinitionVersion", "mealDefinition",
    "leaveRequest", "calendarEvent", "storedFile",
    "userPolicyAcceptance", "userStatusHistory", "session", "userProfile", "user",
    "policyVersion", "policy", "institutionSecuritySettings", "institutionSettings", "institution",
  ];
  for (const t of tables) {
    // @ts-expect-error dynamic table deletion for the dev seed only
    await db[t].deleteMany();
  }
}

async function main() {
  console.log("🌱 Seeding Aurora Residency Mess (development data)…");
  await wipe();

  // ---------------------------------------------------------------- institution
  const inst = await db.institution.create({
    data: {
      name: "Aurora Residency Mess",
      timezone: TZ,
      currencyCode: "INR",
      currencyMinorDigits: 2,
      status: "ACTIVE",
      settings: {
        create: {
          deficitThresholdMinor: 100000, // ₹1,000
          gracePeriodDays: 7,
          restrictMealsOnDeficit: true,
          deficitPolicyEnabled: true,
          billingDueDays: 10,
          guestMealPriceMinor: 5500, // ₹55.00
        },
      },
      securitySettings: {
        create: { requireReasonOnOverride: true },
      },
    },
    include: { settings: true },
  });

  // ---------------------------------------------------------------- policies
  const policyData = [
    { type: "TERMS_OF_SERVICE", title: "Terms of Service", content: "By joining Aurora Residency Mess you agree to use this platform honestly for meal planning, payments and mess operations. Amounts shown are informative; the monthly bill is the authoritative statement. Misuse of the platform may lead to account deactivation." },
    { type: "PRIVACY", title: "Privacy Notice", content: "Your profile, meal choices and payment records are visible only to you and the mess administration. Financial history is retained for accounting integrity. Proof documents are stored privately and never shared with other residents." },
    { type: "HOUSE_RULES", title: "Meal & House Rules", content: "Meal cutoffs are enforced by server time: breakfast 06:30, lunch 09:00, dinner 17:00 same-day. Changes after cutoff require an admin override with a reason. Approved leave automatically turns future unlocked meals off. Guest meals are charged at the fixed guest price." },
  ];
  const policyRows = [];
  for (const p of policyData) {
    const row = await db.policy.create({
      data: { institutionId: inst.id, type: p.type, title: p.title, content: p.content, status: "ACTIVE" },
    });
    await db.policyVersion.create({ data: { policyId: row.id, version: 1, content: p.content } });
    policyRows.push(row);
  }

  // ---------------------------------------------------------------- users
  const mkUser = async (email: string, role: string, status: string, fullName: string, room: string, from?: Date) => {
    const u = await db.user.create({
      data: {
        institutionId: inst.id,
        role,
        status,
        email,
        passwordHash: await hashPassword(role === "ADMIN" ? ADMIN_PASSWORD : RESIDENT_PASSWORD),
        membershipEffectiveFrom: from ?? new Date(Date.UTC(prev.year, prev.month - 1, 1)),
      },
    });
    // Relation direction per current schema: FK lives on User.userProfileId.
    const profile = await db.userProfile.create({
      data: {
        userId: u.id,
        fullName,
        roomNumber: room,
        phone: "+91 98xxxxxx" + Math.abs(hashCode(email)) % 100,
        avatarColor: pickColor(email),
      },
    });
    await db.user.update({ where: { id: u.id }, data: { userProfileId: profile.id } });
    await db.userStatusHistory.create({
      data: { userId: u.id, toStatus: status, reason: status === "PENDING_APPROVAL" ? "Registration submitted" : "Development seed" },
    });
    return u;
  };
  function hashCode(s: string) { let h = 0; for (const c of s) h = (h * 31 + c.charCodeAt(0)) | 0; return h; }
  function pickColor(s: string) { const colors = ["emerald", "teal", "amber", "rose", "sky", "slate"]; return colors[Math.abs(hashCode(s)) % colors.length]; }

  const admin = await mkUser(ADMIN_EMAIL, "ADMIN", "ACTIVE", "Mess Administrator", "A-01", new Date(Date.UTC(prev.year, prev.month - 1, 1)));
  const residents = [
    await mkUser("sahid@messtest.in", "RESIDENT", "ACTIVE", "Sahid Haque", "B-104"),
    await mkUser("riya@messtest.in", "RESIDENT", "ACTIVE", "Riya Sharma", "B-108"),
    await mkUser("arjun@messtest.in", "RESIDENT", "ACTIVE", "Arjun Patel", "B-112"),
    await mkUser("meera@messtest.in", "RESIDENT", "ACTIVE", "Meera Iyer", "B-201"),
    await mkUser("farhan@messtest.in", "RESIDENT", "ACTIVE", "Farhan Khan", "B-205"),
  ];
  const pendingResident = await mkUser("newres@messtest.in", "RESIDENT", "PENDING_APPROVAL", "Nikhil Verma", "B-210");
  for (const r of residents) {
    for (const p of policyRows) {
      const v = await db.policyVersion.findFirst({ where: { policyId: p.id }, orderBy: { version: "desc" } });
      if (v) await db.userPolicyAcceptance.create({ data: { userId: r.id, policyId: p.id, policyVersionId: v.id, ip: "127.0.0.1", userAgent: "seed" } });
    }
  }

  // ---------------------------------------------------------------- meal definitions + versions
  const defs = [
    { name: "Breakfast", icon: "coffee", colorToken: "amber", start: "07:30", end: "09:00", cutoff: "06:30", defaultState: "ON", desc: "Morning breakfast — tea, poha, paratha" },
    { name: "Lunch", icon: "utensils", colorToken: "emerald", start: "12:30", end: "14:00", cutoff: "09:00", defaultState: "ON", desc: "Afternoon lunch — rice, dal, sabzi, roti" },
    { name: "Dinner", icon: "moon", colorToken: "sky", start: "20:00", end: "21:30", cutoff: "17:00", defaultState: "ON", desc: "Evening dinner — thali with dessert twice a week" },
  ] as const;
  const defRows = [];
  for (const d of defs) {
    const def = await db.mealDefinition.create({
      data: {
        institutionId: inst.id,
        name: d.name,
        description: d.desc,
        icon: d.icon,
        colorToken: d.colorToken,
        mealType: "REGULAR",
        active: true,
        defaultState: d.defaultState,
        defaultVisible: true,
        pricingStrategy: "FORMULA",
        scheduleStrategy: "DAILY",
        serviceStartLocal: d.start,
        serviceEndLocal: d.end,
        cutoffStrategy: "SAME_DAY",
        cutoffLocalTime: d.cutoff,
        internalNotes: "Seeded default configuration.",
      },
    });
    const version = await db.mealDefinitionVersion.create({
      data: {
        mealDefinitionId: def.id,
        version: 1,
        configSnapshotJson: JSON.stringify({ name: def.name, serviceStartLocal: def.serviceStartLocal, serviceEndLocal: def.serviceEndLocal, cutoffLocalTime: def.cutoffLocalTime, cutoffStrategy: def.cutoffStrategy, defaultState: def.defaultState, pricingStrategy: def.pricingStrategy }),
        createdByUserId: admin.id,
      },
    });
    defRows.push({ def, version, cutoff: d.cutoff, start: d.start, end: d.end, defaultState: d.defaultState });
  }

  // ---------------------------------------------------------------- instances + resident meals
  const mkInstance = async (defRow: (typeof defRows)[number], dateKey: string) => {
    const serviceDate = localDateMidnightUtc(dateKey);
    const cutoffAt = computeCutoffAt(dateKey, defRow.def.cutoffLocalTime, 0, TZ);
    const window = computeServiceWindow(dateKey, defRow.def.serviceStartLocal, defRow.def.serviceEndLocal, TZ);
    const status = now < cutoffAt ? "OPEN" : "LOCKED";
    return db.mealInstance.create({
      data: {
        institutionId: inst.id,
        mealDefinitionId: defRow.def.id,
        mealDefinitionVersionId: defRow.version.id,
        serviceDate,
        serviceStartAt: window.startAt,
        serviceEndAt: window.endAt,
        cutoffAt,
        lockAt: cutoffAt,
        status,
        priceStrategySnapshot: "FORMULA",
      },
    }).catch(() => null); // unique guard
  };

  const instancesByDef: Record<string, { id: string; dateKey: string; cutoffAt: Date; def: string }[]> = { Breakfast: [], Lunch: [], Dinner: [] };
  for (const defRow of defRows) {
    for (const k of [...prevDays, ...curDays]) {
      const instRow = await mkInstance(defRow, k);
      if (instRow) instancesByDef[defRow.def.name].push({ id: instRow.id, dateKey: k, cutoffAt: instRow.cutoffAt, def: defRow.def.name });
    }
  }

  // Resident meals with deterministic variety.
  let rmCount = 0;
  const mkResidentMeal = async (residentId: string, inst: { id: string; dateKey: string; cutoffAt: Date; def: string }, idx: number) => {
    const past = inst.cutoffAt < now;
    // deterministic OFF pattern: every ~6th meal off per resident offset
    const off = (idx + hashCode(residentId)) % 6 === 0;
    const selected = off ? "OFF" : null;
    const effective = off ? "OFF" : "ON";
    await db.residentMeal.create({
      data: {
        institutionId: inst2institution(),
        residentId,
        mealInstanceId: inst.id,
        baselineState: "ON",
        residentSelectedState: selected,
        effectiveState: effective,
        effectiveReason: off ? "RESIDENT_SELECTION" : "BASELINE_DEFAULT",
        lockedAt: past ? inst.cutoffAt : null,
        version: 1,
      },
    }).catch(() => null);
    rmCount++;
  };
  const inst2institution = () => inst.id;
  for (const [rIdx, r] of residents.entries()) {
    let i = 0;
    for (const defName of ["Breakfast", "Lunch", "Dinner"]) {
      for (const instance of instancesByDef[defName]) {
        // skip first resident-day combos to vary counts
        if ((i + rIdx) % 11 === 5) { i++; continue; }
        await mkResidentMeal(r.id, instance, i);
        i++;
      }
    }
  }
  console.log(`   meal instances: ${Object.values(instancesByDef).flat().length}, resident meals: ${rmCount}`);

  // One admin override example (spec §29): sahid's Dinner today forced OFF.
  const sahidDinnerToday = instancesByDef.Dinner.find((x) => x.dateKey === todayKey);
  if (sahidDinnerToday) {
    const rm = await db.residentMeal.findUnique({ where: { residentId_mealInstanceId: { residentId: residents[0].id, mealInstanceId: sahidDinnerToday.id } } });
    if (rm) {
      await db.residentMeal.update({
        where: { id: rm.id },
        data: { adminOverrideState: "OFF", effectiveState: "OFF", effectiveReason: "ADMIN_OVERRIDE", version: rm.version + 1 },
      });
      await db.auditEvent.create({
        data: {
          institutionId: inst.id, actorUserId: admin.id, actorRole: "ADMIN", action: "MEAL_OVERRIDDEN",
          entityType: "RESIDENT_MEAL", entityId: rm.id, reason: "Kitchen capacity adjustment",
          beforeSummary: JSON.stringify({ effectiveState: "ON" }), afterSummary: JSON.stringify({ effectiveState: "OFF" }),
        },
      });
    }
  }

  // ---------------------------------------------------------------- ledger accounts
  const accounts: Record<string, string> = {};
  for (const a of [
    { code: "CASH", name: "Cash & Bank", type: "ASSET" },
    { code: "RESIDENT_FUNDS", name: "Resident Funds Held", type: "LIABILITY" },
    { code: "MESS_EXPENSE", name: "Mess Expenses", type: "EXPENSE" },
    { code: "MEAL_CHARGE_INCOME", name: "Meal Charge Recovery", type: "INCOME" },
    { code: "GUEST_INCOME", name: "Guest Meal Income", type: "INCOME" },
    { code: "REFUND_PAYABLE", name: "Refunds Payable", type: "LIABILITY" },
  ]) {
    const row = await db.ledgerAccount.create({ data: { institutionId: inst.id, ...a } });
    accounts[a.code] = row.id;
  }
  const postJournal = async (description: string, refType: string, refId: string, lines: { code: string; debit?: number; credit?: number }[]) => {
    const j = await db.ledgerJournal.create({ data: { institutionId: inst.id, description, refType, refId, createdByUserId: admin.id } });
    await db.ledgerEntry.createMany({
      data: lines.map((l) => ({ journalId: j.id, accountId: accounts[l.code], debitMinor: l.debit ?? 0, creditMinor: l.credit ?? 0 })),
    });
    return j.id;
  };

  // ---------------------------------------------------------------- formula
  const formulaDef = await db.formulaDefinition.create({ data: { institutionId: inst.id, name: "Meal Charge" } });
  const ast = {
    type: "op",
    op: "/",
    left: { type: "op", op: "-", left: { type: "var", name: "total_market_cost" }, right: { type: "var", name: "total_guest_income" } },
    right: { type: "var", name: "total_consumed_resident_meals" },
  };
  await db.formulaVersion.create({
    data: {
      formulaDefinitionId: formulaDef.id,
      version: 1,
      inputMode: "FORMULA",
      expressionSource: "(total_market_cost - total_guest_income) / total_consumed_resident_meals",
      compiledAstJson: JSON.stringify(ast),
      humanPreview: "(Total Market Cost − Guest Income) ÷ Resident Consumed Meals",
      checksum: "seed-v1",
      createdByUserId: admin.id,
      reason: "Initial formula",
      effectiveFrom: localDateMidnightUtc(cur.startKey),
      active: true,
    },
  });
  await db.formulaDefinition.update({ where: { id: formulaDef.id }, data: { activeVersionId: (await db.formulaVersion.findFirst({ where: { formulaDefinitionId: formulaDef.id } }))!.id } });

  // ---------------------------------------------------------------- payments (previous + current month)
  let paySeq = 0;
  const mkPayment = async (residentId: string, amountMinor: number, method: string, status: string, daysAgo: number, reference: string) => {
    paySeq++;
    const submittedAt = new Date(now.getTime() - daysAgo * 24 * 3600 * 1000);
    const p = await db.payment.create({
      data: {
        institutionId: inst.id,
        displayNumber: `PAY-${paySeq < 10 ? "0" : ""}${paySeq}`.replace("PAY-", `PAY-${cur.year}${String(cur.month).padStart(2, "0")}-`),
        residentId, amountMinor, method, reference, status, submittedAt,
        reviewedAt: status === "PENDING" ? null : submittedAt,
        reviewedByUserId: status === "PENDING" ? null : admin.id,
      },
    });
    await db.paymentStatusHistory.create({ data: { paymentId: p.id, toStatus: "PENDING" } });
    let journalId: string | null = null;
    if (status === "APPROVED") {
      journalId = await postJournal(`Payment ${p.displayNumber} approved`, "PAYMENT", p.id, [
        { code: "CASH", debit: amountMinor },
        { code: "RESIDENT_FUNDS", credit: amountMinor },
      ]);
      await db.payment.update({ where: { id: p.id }, data: { approvedJournalId: journalId } });
      await db.paymentStatusHistory.create({ data: { paymentId: p.id, fromStatus: "PENDING", toStatus: "APPROVED", changedByUserId: admin.id } });
      await db.auditEvent.create({ data: { institutionId: inst.id, actorUserId: admin.id, actorRole: "ADMIN", action: "PAYMENT_APPROVED", entityType: "PAYMENT", entityId: p.id, afterSummary: JSON.stringify({ amountMinor, status: "APPROVED", journalId }) } });
      await db.notification.create({ data: { institutionId: inst.id, userId: residentId, type: "PAYMENT_APPROVED", title: "Payment approved", message: `Payment of ₹${(amountMinor / 100).toLocaleString("en-IN")} approved.`, entityRef: p.id } });
    }
    return p;
  };

  // Previous month payments (part of snapshot) + current month.
  const prevPay = [
    await mkPayment(residents[0].id, 350000, "UPI", "APPROVED", 20, "UPI/334455"),
    await mkPayment(residents[1].id, 300000, "BANK_TRANSFER", "APPROVED", 18, "NEFT/8811"),
    await mkPayment(residents[2].id, 300000, "UPI", "APPROVED", 15, "UPI/9911"),
    await mkPayment(residents[3].id, 280000, "CASH", "APPROVED", 12, "CASH-counter"),
    await mkPayment(residents[4].id, 320000, "UPI", "APPROVED", 9, "UPI/5522"),
  ];
  const curPay = [
    await mkPayment(residents[0].id, 200000, "UPI", "PENDING", 1, "UPI/77213"), // sahid pending
    await mkPayment(residents[1].id, 150000, "UPI", "APPROVED", 2, "UPI/77214"),
    await mkPayment(residents[3].id, 100000, "CASH", "PENDING", 1, "CASH-2"),
  ];

  // ---------------------------------------------------------------- expenses
  const catRows: Record<string, string> = {};
  for (const c of ["Grocery", "Vegetables", "Gas & Fuel", "Maintenance", "Dairy"]) {
    const row = await db.expenseCategory.create({ data: { institutionId: inst.id, name: c } });
    catRows[c] = row.id;
  }
  let expSeq = 0;
  const mkExpense = async (categoryId: string | null, description: string, items: { itemName: string; quantity: number; unit: string; unitPriceMinor: number }[], daysAgo: number, status: string, source: string = "DIRECT") => {
    expSeq++;
    const total = items.reduce((s, it) => s + Math.round(it.quantity * it.unitPriceMinor), 0);
    const e = await db.expense.create({
      data: {
        institutionId: inst.id,
        displayNumber: `EXP-${cur.year}${String(cur.month).padStart(2, "0")}-${String(expSeq).padStart(4, "0")}`,
        date: new Date(now.getTime() - daysAgo * 24 * 3600 * 1000),
        categoryId, status, source, description,
        submittedByUserId: admin.id,
        approvedByUserId: status === "APPROVED" ? admin.id : null,
        reviewedAt: status === "APPROVED" ? new Date() : null,
        totalMinor: total,
        items: { create: items.map((it, idx) => ({ ...it, lineTotalMinor: Math.round(it.quantity * it.unitPriceMinor), sortOrder: idx })) },
      },
    });
    if (status === "APPROVED") {
      const jId = await postJournal(`Expense ${e.displayNumber} approved`, "EXPENSE", e.id, [
        { code: "MESS_EXPENSE", debit: total },
        { code: "CASH", credit: total },
      ]);
      await db.expense.update({ where: { id: e.id }, data: { journalId: jId } });
      await db.auditEvent.create({ data: { institutionId: inst.id, actorUserId: admin.id, actorRole: "ADMIN", action: "EXPENSE_APPROVED", entityType: "EXPENSE", entityId: e.id, afterSummary: JSON.stringify({ totalMinor: total, journalId: jId }) } });
    }
    return e;
  };
  // Previous month expenses — sized so (market cost − guest income) ÷ ~351 meals ≈ ₹40/meal.
  const prevExpenses = [
    await mkExpense(catRows.Grocery, "Monthly grocery stock", [{ itemName: "Rice (25kg bags)", quantity: 6, unit: "bag", unitPriceMinor: 140000 }, { itemName: "Atta (10kg)", quantity: 8, unit: "bag", unitPriceMinor: 40000 }], 27, "APPROVED"),
    await mkExpense(catRows.Vegetables, "Weekly vegetable run", [{ itemName: "Mixed vegetables", quantity: 20, unit: "kg", unitPriceMinor: 8500 }, { itemName: "Onions", quantity: 10, unit: "kg", unitPriceMinor: 4000 }], 25, "APPROVED"),
    await mkExpense(catRows.Dairy, "Milk & dairy", [{ itemName: "Milk", quantity: 10, unit: "litre", unitPriceMinor: 6700 }], 18, "APPROVED"),
  ];
  const curExpenses = [
    await mkExpense(catRows.Grocery, "Mid-month grocery top-up", [{ itemName: "Dal varieties", quantity: 10, unit: "kg", unitPriceMinor: 12000 }], 6, "APPROVED"),
    await mkExpense(catRows.Vegetables, "Fresh vegetables", [{ itemName: "Seasonal mix", quantity: 25, unit: "kg", unitPriceMinor: 7000 }], 2, "PENDING"),
  ];
  void prevExpenses; void curExpenses;

  // ---------------------------------------------------------------- guest meals (previous month, counted in bills)
  const prevLunches = instancesByDef.Lunch.filter((x) => prevDays.includes(x.dateKey));
  const guestUnit = 5500;
  const mkGuest = async (hostIdx: number, instId: string, qty: number) => {
    await db.guestMealRequest.create({
      data: {
        institutionId: inst.id, hostResidentId: residents[hostIdx].id, mealInstanceId: instId,
        quantity: qty, unitPriceMinor: guestUnit, totalPriceMinor: qty * guestUnit,
        status: "CONFIRMED", note: "Family visit",
      },
    });
    return qty * guestUnit;
  };
  let guestIncomePrev = 0;
  if (prevLunches[2]) guestIncomePrev += await mkGuest(0, prevLunches[2].id, 2);
  if (prevLunches[6]) guestIncomePrev += await mkGuest(1, prevLunches[6].id, 1);
  if (prevLunches[10]) guestIncomePrev += await mkGuest(3, prevLunches[10].id, 3);
  // current month guest meal
  const curLunch = instancesByDef.Lunch.find((x) => x.dateKey === addDaysToKey(todayKey, 1));
  if (curLunch) await mkGuest(0, curLunch.id, 2);

  // ---------------------------------------------------------------- leave requests
  await db.leaveRequest.create({
    data: {
      institutionId: inst.id, residentId: residents[4].id, // farhan
      startDate: localDateMidnightUtc(addDaysToKey(todayKey, 1)),
      endDate: localDateMidnightUtc(addDaysToKey(todayKey, 4)),
      reason: "Family function out of town", status: "PENDING",
    },
  });
  const approvedLeave = await db.leaveRequest.create({
    data: {
      institutionId: inst.id, residentId: residents[2].id, // arjun
      startDate: localDateMidnightUtc(addDaysToKey(todayKey, 2)),
      endDate: localDateMidnightUtc(addDaysToKey(todayKey, 6)),
      reason: "Conference travel", status: "APPROVED",
      reviewedAt: new Date(), reviewedByUserId: admin.id, reviewReason: "Approved — documented travel",
    },
  });
  // Apply approved leave to future unlocked arjun meals.
  const arjunFutureRms = await db.residentMeal.findMany({
    where: { residentId: residents[2].id, mealInstance: { serviceDate: { gte: localDateMidnightUtc(addDaysToKey(todayKey, 2)), lte: localDateMidnightUtc(addDaysToKey(todayKey, 6)) }, cutoffAt: { gt: now } } },
  });
  for (const rm of arjunFutureRms) {
    await db.residentMeal.update({ where: { id: rm.id }, data: { leaveState: "ON_LEAVE", effectiveState: "ON_LEAVE", effectiveReason: "LEAVE_APPROVED" } });
  }
  void approvedLeave;

  // ---------------------------------------------------------------- calendar events
  await db.calendarEvent.create({
    data: { institutionId: inst.id, name: "Durga Puja", description: "Festival celebration — special dinner", startDate: localDateMidnightUtc(addDaysToKey(todayKey, 8)), endDate: localDateMidnightUtc(addDaysToKey(todayKey, 9)), type: "FESTIVAL", disableMeals: false, createdByUserId: admin.id },
  });
  await db.calendarEvent.create({
    data: { institutionId: inst.id, name: "Kitchen deep-clean", description: "Maintenance — meals disabled", startDate: localDateMidnightUtc(addDaysToKey(todayKey, 12)), endDate: localDateMidnightUtc(addDaysToKey(todayKey, 13)), type: "MAINTENANCE", disableMeals: true, createdByUserId: admin.id },
  });

  // ---------------------------------------------------------------- tasks
  const taskApproved = await db.task.create({
    data: {
      institutionId: inst.id, taskType: "MARKET_PURCHASE", description: "Weekly vegetable market run",
      assignedResidentId: residents[1].id, assignedByUserId: admin.id,
      dueDate: localDateMidnightUtc(addDaysToKey(todayKey, -3)), notes: "Buy from wholesale market", estimatedAmountMinor: 250000,
      status: "APPROVED",
      items: { create: [{ itemName: "Mixed vegetables", expectedQuantity: 20, unit: "kg", estimatedUnitPriceMinor: 8500 }, { itemName: "Onions", expectedQuantity: 10, unit: "kg", estimatedUnitPriceMinor: 4000 }] },
    },
  });
  // its submission (approved) → official expense
  const subApproved = await db.taskSubmission.create({
    data: {
      taskId: taskApproved.id, comment: "Bought from Howrah wholesale market", claimedTotalMinor: 225000, status: "APPROVED",
      submittedAt: new Date(now.getTime() - 3 * 24 * 3600 * 1000), reviewedAt: new Date(), reviewedByUserId: admin.id,
      items: { create: [{ itemName: "Mixed vegetables", quantity: 20, unit: "kg", unitPriceMinor: 8500, lineTotalMinor: 170000 }, { itemName: "Onions", quantity: 10, unit: "kg", unitPriceMinor: 4000, lineTotalMinor: 40000 }] },
    },
  });
  const taskTotal = 170000 + 40000; // ₹2,100 — server-recomputed truth
  const taskExpense = await db.expense.create({
    data: {
      institutionId: inst.id, displayNumber: `EXP-${cur.year}${String(cur.month).padStart(2, "0")}-${String(++expSeq).padStart(4, "0")}`,
      date: new Date(now.getTime() - 3 * 24 * 3600 * 1000), categoryId: catRows.Vegetables, status: "APPROVED", source: "TASK",
      description: "Market purchase — Weekly vegetable market run", comment: "Bought from Howrah wholesale market",
      submittedByUserId: residents[1].id, approvedByUserId: admin.id, reviewedAt: new Date(), totalMinor: taskTotal,
      sourceTaskSubmissionId: subApproved.id,
      items: { create: [{ itemName: "Mixed vegetables", quantity: 20, unit: "kg", unitPriceMinor: 8500, lineTotalMinor: 170000, sortOrder: 0 }, { itemName: "Onions", quantity: 10, unit: "kg", unitPriceMinor: 4000, lineTotalMinor: 40000, sortOrder: 1 }] },
    },
  });
  const taskJournal = await postJournal("Expense EXP-TASK approved", "TASK_EXPENSE", taskExpense.id, [
    { code: "MESS_EXPENSE", debit: taskTotal },
    { code: "CASH", credit: taskTotal },
  ]);
  await db.expense.update({ where: { id: taskExpense.id }, data: { journalId: taskJournal } });
  await db.taskSubmission.update({ where: { id: subApproved.id }, data: { expenseId: taskExpense.id } });

  const taskSubmitted = await db.task.create({
    data: {
      institutionId: inst.id, taskType: "MARKET_PURCHASE", description: "Rice & staples restock",
      assignedResidentId: residents[3].id, assignedByUserId: admin.id,
      dueDate: localDateMidnightUtc(addDaysToKey(todayKey, 1)), notes: "Get basmati if available", estimatedAmountMinor: 300000,
      status: "SUBMITTED",
      items: { create: [{ itemName: "Basmati rice", expectedQuantity: 25, unit: "kg", estimatedUnitPriceMinor: 90000 }] },
    },
  });
  await db.taskSubmission.create({
    data: {
      taskId: taskSubmitted.id, comment: "Prices were higher this week", claimedTotalMinor: 275000, status: "SUBMITTED",
      items: { create: [{ itemName: "Basmati rice", quantity: 25, unit: "kg", unitPriceMinor: 11000, lineTotalMinor: 275000 }] },
    },
  });
  await db.task.create({
    data: {
      institutionId: inst.id, taskType: "GENERAL", description: "Dining hall decoration for festival",
      assignedResidentId: residents[0].id, assignedByUserId: admin.id,
      dueDate: localDateMidnightUtc(addDaysToKey(todayKey, 6)), notes: "Marigold garlands + rangoli",
      status: "ASSIGNED",
    },
  });
  await db.notification.create({ data: { institutionId: inst.id, userId: residents[0].id, type: "TASK_ASSIGNED", title: "Task assigned", message: "You were assigned: Dining hall decoration for festival." } });

  // ---------------------------------------------------------------- announcements
  await db.announcement.create({
    data: { institutionId: inst.id, title: "Welcome to Aurora Mess", message: "Monthly billing runs on the 1st. Meal cutoffs: breakfast 06:30, lunch 09:00, dinner 17:00. Welcome aboard!", type: "INFO", priority: "NORMAL", target: "EVERYONE", pinned: true, createdByUserId: admin.id },
  });
  await db.announcement.create({
    data: { institutionId: inst.id, title: "Kitchen maintenance next week", message: "The kitchen will be deep-cleaned — meals will be disabled for 2 days. Plan accordingly.", type: "MAINTENANCE", priority: "HIGH", target: "RESIDENTS", pinned: false, createdByUserId: admin.id },
  });

  // ---------------------------------------------------------------- billing: previous month BILLED with snapshot + bills
  const prevMonthLabel = `${["January","February","March","April","May","June","July","August","September","October","November","December"][prev.month - 1]} ${prev.year}`;

  // counts per resident for previous month
  const prevMealCounts: Record<string, number> = {};
  const prevGuestByResident: Record<string, number> = { [residents[0].id]: 2, [residents[1].id]: 1, [residents[3].id]: 3 };
  for (const r of residents) {
    const cnt = await db.residentMeal.count({
      where: { residentId: r.id, effectiveState: "ON", mealInstance: { serviceDate: { gte: localDateMidnightUtc(prev.startKey), lte: localDateMidnightUtc(prev.endKey) } } },
    });
    prevMealCounts[r.id] = cnt;
  }
  const totalResidentMealsPrev = Object.values(prevMealCounts).reduce((s, v) => s + v, 0);
  const totalMarketCostPrev = 8180000 + taskTotal; // = prev expenses + task expense? seed prev expenses sum: grocery 8*135000+10*42000=1500000; veg 120*65000+40*32000=9080000? recompute below

  // Recompute actual approved expense totals for the PREVIOUS month window.
  const approvedPrevExpenses = await db.expense.findMany({
    where: { status: "APPROVED", date: { gte: new Date(`${prev.startKey}T00:00:00Z`), lte: new Date(`${prev.endKey}T23:59:59Z`) } },
    select: { totalMinor: true },
  });
  const marketCostPrev = approvedPrevExpenses.reduce((s, e) => s + e.totalMinor, 0);

  const numerator = marketCostPrev - guestIncomePrev;
  const mealChargeMinor = totalResidentMealsPrev > 0 ? Math.round(numerator / totalResidentMealsPrev) : 0;

  const prevPeriod = await db.billingPeriod.create({
    data: {
      institutionId: inst.id, year: prev.year, month: prev.month, status: "BILLED",
      formulaVersionId: (await db.formulaVersion.findFirst({ where: { formulaDefinitionId: formulaDef.id } }))!.id,
      mealChargeMinorSnapshot: mealChargeMinor, guestPriceMinorSnapshot: guestUnit,
      billedAt: new Date(now.getTime() - 8 * 24 * 3600 * 1000), closedAt: new Date(now.getTime() - 9 * 24 * 3600 * 1000),
      createdByUserId: admin.id,
    },
  });

  const snapshotPayload = {
    residents: residents.map((r) => ({ id: r.id, fullName: r.profile?.fullName, mealsOn: prevMealCounts[r.id] })),
    guestMeals: { totalIncomeMinor: guestIncomePrev, byResident: prevGuestByResident },
    eligibleExpenses: { totalMinor: marketCostPrev },
    approvedPayments: { totalMinor: prevPay.reduce((s, p) => s + p.amountMinor, 0) },
    formula: { version: 1, expression: "(total_market_cost - total_guest_income) / total_consumed_resident_meals", mealChargeMinor },
    policies: { guestPriceMinor: guestUnit, billingDueDays: 10 },
  };
  const snapshot = await db.billingSnapshot.create({
    data: {
      institutionId: inst.id, billingPeriodId: prevPeriod.id,
      payloadJson: JSON.stringify(snapshotPayload, null, 2),
      checksum: "seed-snapshot-v1",
      residentCount: residents.length, residentMealCount: totalResidentMealsPrev,
      guestMealCount: Math.round(guestIncomePrev / guestUnit),
      eligibleExpensesMinor: marketCostPrev, approvedPaymentsMinor: prevPay.reduce((s, p) => s + p.amountMinor, 0),
      mealChargeMinor, createdByUserId: admin.id,
    },
  });

  let billSeq = 0;
  const prevPaymentsByResident: Record<string, number> = {};
  for (const p of prevPay) prevPaymentsByResident[p.residentId] = (prevPaymentsByResident[p.residentId] ?? 0) + p.amountMinor;

  for (const r of residents) {
    billSeq++;
    const mealCount = prevMealCounts[r.id] ?? 0;
    const guestQty = prevGuestByResident[r.id] ?? 0;
    const mealCharge = mealCount * mealChargeMinor;
    const guestCharge = guestQty * guestUnit;
    const subtotal = mealCharge + guestCharge;
    const applied = Math.min(prevPaymentsByResident[r.id] ?? 0, subtotal);
    const totalDue = subtotal - applied;
    const bill = await db.bill.create({
      data: {
        institutionId: inst.id, residentId: r.id, billingPeriodId: prevPeriod.id, snapshotId: snapshot.id,
        billNumber: `BILL-${prev.year}${String(prev.month).padStart(2, "0")}-${String(billSeq).padStart(4, "0")}`,
        residentMealCount: mealCount, guestMealCount: guestQty, mealChargeMinor, guestChargeMinor: guestCharge,
        subtotalMinor: subtotal, adjustmentsMinor: 0, paymentsMinor: applied, totalDueMinor: totalDue,
        dueDate: new Date(now.getTime() - 8 * 24 * 3600 * 1000 + 10 * 24 * 3600 * 1000),
        status: totalDue === 0 ? "PAID" : totalDue < subtotal * 0.5 ? "PARTIALLY_PAID" : "GENERATED",
        lines: {
          create: [
            { code: "RESIDENT_MEALS", label: `Resident meals — ${prevMonthLabel}`, quantity: mealCount, unitPriceMinor: mealChargeMinor, amountMinor: mealCharge, detailJson: JSON.stringify({ formula: "(Total Market Cost − Guest Income) ÷ Resident Consumed Meals", marketCostMinor: marketCostPrev, guestIncomeMinor: guestIncomePrev, totalMeals: totalResidentMealsPrev }), sortOrder: 0 },
            { code: "GUEST_MEALS", label: "Guest meals", quantity: guestQty, unitPriceMinor: guestUnit, amountMinor: guestCharge, sortOrder: 1 },
            { code: "PAYMENTS_APPLIED", label: "Payments applied", amountMinor: -applied, sortOrder: 2 },
          ],
        },
      },
    });
    // Journal: Dr RESIDENT_FUNDS subtotal / Cr income accounts (split).
    await postJournal(`Bill ${bill.billNumber} — ${prevMonthLabel}`, "BILL", bill.id, [
      { code: "RESIDENT_FUNDS", debit: subtotal },
      { code: "MEAL_CHARGE_INCOME", credit: mealCharge },
      ...(guestCharge > 0 ? [{ code: "GUEST_INCOME" as string, credit: guestCharge }] : []),
    ]);
    await db.notification.create({ data: { institutionId: inst.id, userId: r.id, type: "BILL_GENERATED", title: `${prevMonthLabel} bill generated`, message: `Your ${prevMonthLabel} bill is ₹${(totalDue / 100).toLocaleString("en-IN", { minimumFractionDigits: 2 })}.`, entityRef: bill.id } });
  }
  await db.auditEvent.create({
    data: { institutionId: inst.id, actorUserId: admin.id, actorRole: "ADMIN", action: "BILLING_GENERATED", entityType: "BILLING_PERIOD", entityId: prevPeriod.id, beforeSummary: JSON.stringify({ status: "OPEN" }), afterSummary: JSON.stringify({ status: "BILLED", billCount: residents.length, mealChargeMinor, totalResidentMealsPrev }) },
  });

  // Current month OPEN period.
  await db.billingPeriod.create({
    data: {
      institutionId: inst.id, year: cur.year, month: cur.month, status: "OPEN",
      formulaVersionId: (await db.formulaVersion.findFirst({ where: { formulaDefinitionId: formulaDef.id } }))!.id,
      createdByUserId: admin.id,
    },
  });

  // ---------------------------------------------------------------- extra notifications
  await db.notification.create({ data: { institutionId: inst.id, userId: residents[0].id, type: "MEAL_OVERRIDDEN", title: "Meal changed by admin", message: `Your Dinner on ${todayKey} was changed to OFF by the admin.` } });
  await db.notification.create({ data: { institutionId: inst.id, userId: residents[4].id, type: "LEAVE_PENDING", title: "Leave request submitted", message: "Your leave request is waiting for admin review." } });

  console.log(`✅ Seed complete.`);
  console.log(`   Institution: ${inst.name} (${TZ}, INR)`);
  console.log(`   Users: admin=${ADMIN_EMAIL}/${ADMIN_PASSWORD}`);
  console.log(`   Resident: sahid@messtest.in / ${RESIDENT_PASSWORD} (also riya/arjun/meera/farhan, pending: newres@messtest.in)`);
  console.log(`   Prev month ${prevMonthLabel}: BILLED — meal charge ₹${(mealChargeMinor / 100).toFixed(2)}, ${totalResidentMealsPrev} meals, market cost ₹${(marketCostPrev / 100).toFixed(0)}`);
  console.log(`   Current month ${cur.year}-${String(cur.month).padStart(2, "0")}: OPEN`);
}

main()
  .catch((e) => {
    console.error("Seed failed:", e);
    process.exit(1);
  })
  .finally(() => db.$disconnect());
