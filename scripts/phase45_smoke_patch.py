from pathlib import Path

p = Path(__file__).resolve().parents[1] / "tests/seeded-refund-center-smoke.py"
text = p.read_text()
old = '''    check(
        (blocked_again.payload.get("error") or {}).get("code") == "REFUND_NOT_ELIGIBLE",
        "second refund decision after carry-forward was not blocked by lifecycle",
    )

    admin_history = admin.get(f"/api/v1/admin/refunds?residentId={resident_id}&limit=100").data or []
    resident_history = resident.get("/api/v1/refunds?limit=100").data or []
    payout_id = payout_refund.get("id")
    carry_id = carry_refund.get("id")
    check(any(row.get("id") == payout_id for row in admin_history), "Admin refund history omitted cash payout")
    check(any(row.get("id") == carry_id for row in admin_history), "Admin refund history omitted carry-forward")
    check(any(row.get("id") == payout_id for row in resident_history), "Resident refund history omitted cash payout")
    check(any(row.get("id") == carry_id for row in resident_history), "Resident refund history omitted carry-forward")
'''
new = '''    check(
        (blocked_again.payload.get("error") or {}).get("code") == "REFUND_NOT_ELIGIBLE",
        "second refund decision after carry-forward was not blocked by lifecycle",
    )

    # Phase 45 correction lifecycle: completed carry-forward history is never
    # deleted. Voiding records an audited correction with no ledger journal and
    # re-opens the same generated-bill cycle for a new refund decision.
    payout_id = payout_refund.get("id")
    carry_id = carry_refund.get("id")
    check(isinstance(carry_id, str) and carry_id, "carry-forward id missing before correction")
    voided_carry = admin.post(
        f"/api/v1/admin/refunds/{carry_id}/void",
        {"reason": "Phase 45 acceptance correction of carry-forward decision"},
    ).data or {}
    check(voided_carry.get("status") == "VOIDED", "carry-forward correction did not reach VOIDED")
    check(voided_carry.get("journalId") is None, "voided carry-forward unexpectedly gained an original journal")
    check(voided_carry.get("reversalJournalId") is None, "voided carry-forward unexpectedly posted a reversal journal")
    check(
        voided_carry.get("voidReason") == "Phase 45 acceptance correction of carry-forward decision",
        "carry-forward correction reason was not preserved",
    )

    duplicate_void = admin.post(
        f"/api/v1/admin/refunds/{carry_id}/void",
        {"reason": "Duplicate correction must fail"},
        expected=409,
    )
    check(
        (duplicate_void.payload.get("error") or {}).get("code") == "REFUND_INVALID_STATE",
        "duplicate refund correction failed with the wrong lifecycle error",
    )

    eligible_after_void = admin.get("/api/v1/admin/refunds/eligible")
    reopened_candidate = candidate_for(eligible_after_void.data or [], resident_id)
    check(reopened_candidate is not None, "voided carry-forward did not reopen Refund Center eligibility")
    check(
        reopened_candidate.get("refundableMinor") == remainder,
        "reopened Refund Center amount changed after carry-forward correction",
    )

    recarry = admin.post(
        "/api/v1/admin/refunds",
        {
            "residentId": resident_id,
            "amount": minor_to_decimal(remainder),
            "mode": "CARRY_FORWARD",
            "reason": "Phase 45 re-confirm corrected carry-forward decision",
        },
    ).data or {}
    recarry_refund = recarry.get("refund") or {}
    check(recarry_refund.get("status") == "COMPLETED", "re-selected carry-forward did not complete")
    check(recarry_refund.get("id") != carry_id, "correction rewrote old carry-forward instead of appending history")

    admin_history = admin.get(f"/api/v1/admin/refunds?residentId={resident_id}&limit=100").data or []
    resident_history = resident.get("/api/v1/refunds?limit=100").data or []
    old_admin_carry = next((row for row in admin_history if row.get("id") == carry_id), None)
    old_resident_carry = next((row for row in resident_history if row.get("id") == carry_id), None)
    check(any(row.get("id") == payout_id for row in admin_history), "Admin refund history omitted cash payout")
    check(old_admin_carry is not None, "Admin refund history omitted corrected carry-forward")
    check(old_admin_carry.get("status") == "VOIDED", "Admin refund history hid the carry-forward correction state")
    check(any(row.get("id") == recarry_refund.get("id") for row in admin_history), "Admin refund history omitted re-selected carry-forward")
    check(any(row.get("id") == payout_id for row in resident_history), "Resident refund history omitted cash payout")
    check(old_resident_carry is not None, "Resident refund history omitted corrected carry-forward")
    check(old_resident_carry.get("status") == "VOIDED", "Resident refund history hid the carry-forward correction state")
    check(any(row.get("id") == recarry_refund.get("id") for row in resident_history), "Resident refund history omitted re-selected carry-forward")
'''
if text.count(old) != 1:
    raise SystemExit(f"seeded smoke assertion failed: {text.count(old)}")
p.write_text(text.replace(old, new, 1))
print("Phase 45 Refund Center smoke extended")
