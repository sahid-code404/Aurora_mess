#!/usr/bin/env python3
"""Production-standalone Refund Center acceptance over the deterministic seed.

This mutates only the disposable CI database. It validates the user-visible
post-billing overpayment lifecycle through HTTP rather than importing domain
functions directly.
"""

from __future__ import annotations

import json
import os
import sys
import uuid
from dataclasses import dataclass
from urllib.error import HTTPError, URLError
from urllib.request import Request, build_opener

BASE_URL = os.environ.get("BOARDOPS_REFUND_SMOKE_BASE_URL", "http://127.0.0.1:3103").rstrip("/")
ADMIN_EMAIL = "admin@messtest.in"
ADMIN_PASSWORD = "Admin#12345"
RESIDENT_EMAIL = "sahid@messtest.in"
RESIDENT_PASSWORD = "Resident#12345"


class SmokeFailure(RuntimeError):
    pass


def check(condition: bool, message: str) -> None:
    if not condition:
        raise SmokeFailure(message)


def minor_to_decimal(value: int) -> str:
    return f"{value // 100}.{value % 100:02d}"


def multipart(fields: dict[str, str]) -> tuple[bytes, str]:
    boundary = f"----BoardOpsPhase20{uuid.uuid4().hex}"
    chunks: list[bytes] = []
    for name, value in fields.items():
        chunks.extend(
            [
                f"--{boundary}\r\n".encode(),
                f'Content-Disposition: form-data; name="{name}"\r\n\r\n'.encode(),
                value.encode("utf-8"),
                b"\r\n",
            ]
        )
    chunks.append(f"--{boundary}--\r\n".encode())
    return b"".join(chunks), f"multipart/form-data; boundary={boundary}"


@dataclass
class Response:
    status: int
    payload: dict

    @property
    def data(self):
        return self.payload.get("data")

    @property
    def meta(self):
        return self.payload.get("meta") or {}


class ApiClient:
    def __init__(self, label: str):
        self.label = label
        self.opener = build_opener()
        self.session_token: str | None = None

    def request(
        self,
        method: str,
        path: str,
        *,
        body: object | None = None,
        form: dict[str, str] | None = None,
        expected: int = 200,
    ) -> Response:
        url = f"{BASE_URL}{path}"
        headers = {"Accept": "application/json"}
        if self.session_token:
            headers["Cookie"] = f"mes_session={self.session_token}"
        if method.upper() not in {"GET", "HEAD", "OPTIONS"}:
            headers["Origin"] = BASE_URL

        raw: bytes | None = None
        if body is not None and form is not None:
            raise SmokeFailure("test harness cannot send JSON and multipart together")
        if body is not None:
            raw = json.dumps(body, separators=(",", ":")).encode("utf-8")
            headers["Content-Type"] = "application/json"
        elif form is not None:
            raw, content_type = multipart(form)
            headers["Content-Type"] = content_type

        req = Request(url, data=raw, headers=headers, method=method.upper())
        cookies: list[str] = []
        try:
            with self.opener.open(req, timeout=15) as response:
                status = response.status
                cookies = response.headers.get_all("Set-Cookie") or []
                text = response.read().decode("utf-8")
        except HTTPError as error:
            status = error.code
            cookies = error.headers.get_all("Set-Cookie") or []
            text = error.read().decode("utf-8", errors="replace")
        except URLError as error:
            raise SmokeFailure(f"{self.label} {method} {path} failed to connect: {error}") from error

        for cookie in cookies:
            if cookie.startswith("mes_session="):
                token = cookie.split(";", 1)[0].split("=", 1)[1]
                self.session_token = token or None

        try:
            payload = json.loads(text) if text else {}
        except json.JSONDecodeError as error:
            raise SmokeFailure(
                f"{self.label} {method} {path} returned non-JSON HTTP {status}: {text[:500]!r}"
            ) from error

        if status != expected:
            raise SmokeFailure(
                f"{self.label} {method} {path} returned HTTP {status}, expected {expected}: {payload!r}"
            )
        if 200 <= expected < 300:
            check(payload.get("ok") is True, f"{self.label} {method} {path} did not return ok=true")
        return Response(status, payload)

    def get(self, path: str, *, expected: int = 200) -> Response:
        return self.request("GET", path, expected=expected)

    def post(self, path: str, body: object | None = None, *, expected: int = 200) -> Response:
        return self.request("POST", path, body={} if body is None else body, expected=expected)

    def post_form(self, path: str, fields: dict[str, str], *, expected: int = 200) -> Response:
        return self.request("POST", path, form=fields, expected=expected)

    def login(self, email: str, password: str, role: str) -> dict:
        response = self.post("/api/v1/auth/login", {"email": email, "password": password})
        data = response.data or {}
        user = data.get("user") or {}
        check(user.get("email") == email, f"{self.label} login email mismatch")
        check(user.get("role") == role, f"{self.label} login role mismatch")
        check(bool(self.session_token), f"{self.label} login did not emit mes_session")
        me = self.get("/api/v1/auth/me").data or {}
        check((me.get("user") or {}).get("role") == role, f"{self.label} session role mismatch")
        return me


def candidate_for(rows: list[dict], resident_id: str) -> dict | None:
    return next((row for row in rows if row.get("residentId") == resident_id), None)


def main() -> None:
    admin = ApiClient("admin")
    resident = ApiClient("resident")
    admin.login(ADMIN_EMAIL, ADMIN_PASSWORD, "ADMIN")
    resident_me = resident.login(RESIDENT_EMAIL, RESIDENT_PASSWORD, "RESIDENT")
    resident_id = ((resident_me.get("user") or {}).get("id"))
    check(isinstance(resident_id, str) and resident_id, "resident id missing")

    # The Refund Center must never exist before billing. The deterministic seed
    # already includes an authoritative billed history for Sahid; verify that
    # prerequisite before creating any new credit.
    bills = resident.get("/api/v1/bills?limit=100").data or []
    check(len(bills) > 0, "seeded resident has no generated bill for refund lifecycle acceptance")

    eligible_before = admin.get("/api/v1/admin/refunds/eligible")
    check(eligible_before.meta.get("hasGeneratedBills") is True, "Refund Center does not detect generated bills")
    check(
        int(eligible_before.meta.get("carriedForwardCount") or 0) == 0,
        "deterministic seed unexpectedly contains a prior carry-forward decision",
    )

    payments_before = resident.get("/api/v1/payments?limit=100")
    available_before = payments_before.meta.get("totalAvailableMinor")
    deposits_before = payments_before.meta.get("totalDepositsAllTime")
    cash_refunds_before = int(payments_before.meta.get("refundsThisMonth") or 0)
    carry_forward_before = int(payments_before.meta.get("carriedForwardThisMonth") or 0)
    check(isinstance(available_before, int), "resident available-balance baseline missing")
    check(isinstance(deposits_before, int), "resident deposit baseline missing")

    # Create enough approved credit to guarantee a post-billing excess without
    # relying on the precise amount of the seeded bill.
    payment_key = str(uuid.uuid4())
    payment = resident.post_form(
        "/api/v1/payments",
        {
            "amount": "50000.00",
            "method": "UPI",
            "reference": f"PHASE20-{uuid.uuid4().hex[:10]}",
            "notes": "Phase 20 Refund Center acceptance overpayment",
            "idempotencyKey": payment_key,
        },
    ).data or {}
    payment_id = payment.get("id")
    check(payment.get("status") == "PENDING", "overpayment bypassed Admin review")
    check(isinstance(payment_id, str), "overpayment id missing")

    approved_payment = admin.post(f"/api/v1/admin/payments/{payment_id}/approve").data or {}
    check(approved_payment.get("status") == "APPROVED", "Admin did not approve Refund Center setup payment")

    resident_after_approval = resident.get("/api/v1/payments?limit=100")
    check(
        resident_after_approval.meta.get("totalDepositsAllTime") == deposits_before + 5_000_000,
        "approved overpayment did not increase deposits exactly once",
    )

    eligible = admin.get("/api/v1/admin/refunds/eligible")
    candidate = candidate_for(eligible.data or [], resident_id)
    check(candidate is not None, "post-billing overpayment did not appear in Admin Refund Center")
    refundable = candidate.get("refundableMinor")
    check(isinstance(refundable, int) and refundable > 100, "Refund Center candidate has no meaningful excess")
    check((candidate.get("latestBill") or {}).get("id") in {bill.get("id") for bill in bills}, "Refund Center lost bill provenance")

    # Cash payout may be partial. It must reduce available credit and leave the
    # resident in Refund Center with exactly the remainder.
    partial = max(1, refundable // 3)
    if partial >= refundable:
        partial = refundable - 1
    payout = admin.post(
        "/api/v1/admin/refunds",
        {
            "residentId": resident_id,
            "amount": minor_to_decimal(partial),
            "mode": "ISSUE_REFUND",
            "reason": "Phase 20 partial overpayment payout",
            "paymentId": payment_id,
            "destination": "Phase 20 test UPI destination",
        },
    ).data or {}
    payout_refund = payout.get("refund") or {}
    check(payout_refund.get("mode") == "ISSUE_REFUND", "partial payout returned wrong mode")
    check(payout_refund.get("status") == "COMPLETED", "partial payout did not complete")
    check(payout_refund.get("amountMinor") == partial, "partial payout amount changed")
    check(bool(payout_refund.get("journalId")), "cash refund did not create a journal")
    check((payout.get("residentSummary") or {}).get("availableMinor") == refundable - partial, "cash refund did not reduce available credit")

    eligible_after_payout = admin.get("/api/v1/admin/refunds/eligible")
    remaining_candidate = candidate_for(eligible_after_payout.data or [], resident_id)
    check(remaining_candidate is not None, "partial cash refund incorrectly removed resident from Refund Center")
    remainder = refundable - partial
    check(remaining_candidate.get("refundableMinor") == remainder, "Refund Center remainder is incorrect after partial payout")

    # Carry-forward is not a cash movement. It must resolve the *entire* current
    # cycle remainder, preserve that credit for future bills, and close another
    # refund decision until a newer bill exists.
    partial_carry = max(1, remainder - 1)
    if partial_carry < remainder:
        rejected_partial = admin.post(
            "/api/v1/admin/refunds",
            {
                "residentId": resident_id,
                "amount": minor_to_decimal(partial_carry),
                "mode": "CARRY_FORWARD",
                "reason": "Phase 20 invalid partial carry-forward",
            },
            expected=422,
        )
        check(
            (rejected_partial.payload.get("error") or {}).get("code") == "VALIDATION_FAILED",
            "partial carry-forward failed with the wrong domain error",
        )

    carry = admin.post(
        "/api/v1/admin/refunds",
        {
            "residentId": resident_id,
            "amount": minor_to_decimal(remainder),
            "mode": "CARRY_FORWARD",
            "reason": "Phase 20 carry remaining excess to future bill",
        },
    ).data or {}
    carry_refund = carry.get("refund") or {}
    carry_summary = carry.get("residentSummary") or {}
    check(carry_refund.get("mode") == "CARRY_FORWARD", "carry-forward returned wrong mode")
    check(carry_refund.get("status") == "COMPLETED", "carry-forward did not complete")
    check(carry_refund.get("amountMinor") == remainder, "carry-forward amount changed")
    check(carry_refund.get("journalId") is None, "carry-forward incorrectly moved cash through a journal")
    check(carry_summary.get("availableMinor") == remainder, "carry-forward erased resident credit instead of preserving it")

    eligible_after_carry = admin.get("/api/v1/admin/refunds/eligible")
    check(candidate_for(eligible_after_carry.data or [], resident_id) is None, "carried-forward resident remained in Refund Center")
    check(int(eligible_after_carry.meta.get("carriedForwardCount") or 0) >= 1, "Refund Center did not expose carried-forward cycle state")

    blocked_again = admin.post(
        "/api/v1/admin/refunds",
        {
            "residentId": resident_id,
            "amount": "1.00",
            "mode": "ISSUE_REFUND",
            "reason": "Phase 20 duplicate cycle refund should fail",
        },
        expected=409,
    )
    check(
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

    resident_payment_metrics = resident.get("/api/v1/payments?limit=100").meta
    admin_payment_metrics = admin.get("/api/v1/admin/payments?limit=100").meta
    resident_refund_metrics = resident.get("/api/v1/refunds?limit=100").meta
    admin_refund_metrics = admin.get(f"/api/v1/admin/refunds?residentId={resident_id}&limit=100").meta
    for label, metrics in [
        ("resident payments", resident_payment_metrics),
        ("admin payments", admin_payment_metrics),
        ("resident refunds", resident_refund_metrics),
        ("admin refunds", admin_refund_metrics),
    ]:
        check(
            int(metrics.get("refundsThisMonth") or 0) >= cash_refunds_before + partial,
            f"{label} cash-refund KPI did not include the payout",
        )
        check(
            int(metrics.get("carriedForwardThisMonth") or 0) >= carry_forward_before + remainder,
            f"{label} carry-forward KPI did not expose retained credit separately",
        )

    print(
        json.dumps(
            {
                "status": "passed",
                "paymentId": payment_id,
                "initialAvailableMinor": available_before,
                "refundCenterExcessMinor": refundable,
                "cashRefundId": payout_id,
                "cashRefundMinor": partial,
                "carryForwardId": carry_id,
                "carryForwardMinor": remainder,
            },
            sort_keys=True,
        )
    )


if __name__ == "__main__":
    try:
        main()
    except SmokeFailure as error:
        print(f"seeded Refund Center smoke failed: {error}", file=sys.stderr)
        raise SystemExit(1)
    except Exception as error:
        print(f"seeded Refund Center smoke crashed: {type(error).__name__}: {error}", file=sys.stderr)
        raise
