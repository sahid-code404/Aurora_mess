import { describe, expect, test } from "bun:test";
import { getNotificationTargetRoute } from "@/lib/notification-routes";

describe("notification lifecycle routing", () => {
  test("Admin refund notifications open Payments Refund Center", () => {
    expect(getNotificationTargetRoute("REFUND_ISSUED", "ADMIN", "refund-id")).toBe(
      "#/admin/payments/refunds"
    );
    expect(getNotificationTargetRoute("REFUND_PROCESSING", "ADMIN")).toBe(
      "#/admin/payments/refunds"
    );
  });

  test("Admin payment, deficit and fund notifications keep their own lifecycle destinations", () => {
    expect(getNotificationTargetRoute("PAYMENT_SUBMITTED", "ADMIN")).toBe("#/admin/payments");
    expect(getNotificationTargetRoute("DEFICIT_WARNING", "ADMIN")).toBe("#/admin/funds");
    expect(getNotificationTargetRoute("FUND_STATE_CHANGED", "ADMIN")).toBe("#/admin/funds");
  });

  test("Resident refund notifications open the screen that contains refund history", () => {
    expect(getNotificationTargetRoute("REFUND_ISSUED", "RESIDENT", "refund-id")).toBe(
      "#/app/payments"
    );
    expect(getNotificationTargetRoute("REFUND_COMPLETED", "RESIDENT")).toBe("#/app/payments");
  });

  test("Resident billing and deficit notifications remain on Billing", () => {
    expect(getNotificationTargetRoute("BILL_GENERATED", "RESIDENT")).toBe("#/app/billing");
    expect(getNotificationTargetRoute("DEFICIT_WARNING", "RESIDENT")).toBe("#/app/billing");
    expect(getNotificationTargetRoute("FUND_RESTRICTED", "RESIDENT")).toBe("#/app/billing");
  });

  test("unrelated operational routes are unchanged", () => {
    expect(getNotificationTargetRoute("TASK_ASSIGNED", "ADMIN")).toBe("#/admin/tasks");
    expect(getNotificationTargetRoute("LEAVE_APPROVED", "RESIDENT")).toBe("#/app/meals");
    expect(getNotificationTargetRoute("REGISTRATION_PENDING", "ADMIN", "resident-id")).toBe(
      "#/admin/residents/resident-id"
    );
  });
});
