#!/usr/bin/env python3
"""Black-box production acceptance for Resident pending-payment withdrawal."""

from __future__ import annotations

import json
import os
import uuid
from dataclasses import dataclass
from urllib.error import HTTPError, URLError
from urllib.request import Request, build_opener

BASE_URL = os.environ.get("BOARDOPS_PAYMENT_WITHDRAW_SMOKE_BASE_URL", "http://127.0.0.1:3104").rstrip("/")


class SmokeFailure(RuntimeError):
    pass


def check(condition: bool, message: str) -> None:
    if not condition:
        raise SmokeFailure(message)


def multipart(fields: dict[str, str]) -> tuple[bytes, str]:
    boundary = f"----BoardOpsPhase24{uuid.uuid4().hex}"
    parts: list[bytes] = []
    for name, value in fields.items():
        parts.extend([
            f"--{boundary}\r\n".encode(),
            f'Content-Disposition: form-data; name="{name}"\r\n\r\n'.encode(),
            value.encode(),
            b"\r\n",
        ])
    parts.append(f"--{boundary}--\r\n".encode())
    return b"".join(parts), f"multipart/form-data; boundary={boundary}"


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
        self.cookie: str | None = None

    def request(self, method: str, path: str, *, body=None, form=None, expected=200) -> Response:
        headers = {"Accept": "application/json"}
        if self.cookie:
            headers["Cookie"] = f"mes_session={self.cookie}"
        raw = None
        if method.upper() not in {"GET", "HEAD", "OPTIONS"}:
            headers["Origin"] = BASE_URL
        if body is not None:
            raw = json.dumps(body, separators=(",", ":")).encode()
            headers["Content-Type"] = "application/json"
        elif form is not None:
            raw, content_type = multipart(form)
            headers["Content-Type"] = content_type

        req = Request(f"{BASE_URL}{path}", data=raw, headers=headers, method=method.upper())
        try:
            with self.opener.open(req, timeout=15) as response:
                status = response.status
                cookies = response.headers.get_all("Set-Cookie") or []
                text = response.read().decode()
        except HTTPError as error:
            status = error.code
            cookies = error.headers.get_all("Set-Cookie") or []
            text = error.read().decode(errors="replace")
        except URLError as error:
            raise SmokeFailure(f"{self.label} {method} {path} connection failed: {error}") from error

        for cookie in cookies:
            if cookie.startswith("mes_session="):
                self.cookie = cookie.split(";", 1)[0].split("=", 1)[1] or None

        try:
            payload = json.loads(text) if text else {}
        except json.JSONDecodeError as error:
            raise SmokeFailure(f"{self.label} {method} {path} returned non-JSON: {text[:300]!r}") from error

        if status != expected:
            raise SmokeFailure(f"{self.label} {method} {path}: HTTP {status}, expected {expected}: {payload!r}")
        if 200 <= expected < 300:
            check(payload.get("ok") is True, f"{self.label} {method} {path} did not return ok=true")
        return Response(status, payload)

    def get(self, path: str, *, expected=200) -> Response:
        return self.request("GET", path, expected=expected)

    def post(self, path: str, body=None, *, expected=200) -> Response:
        return self.request("POST", path, body={} if body is None else body, expected=expected)

    def post_form(self, path: str, fields: dict[str, str], *, expected=200) -> Response:
        return self.request("POST", path, form=fields, expected=expected)

    def login(self, email: str, password: str, role: str) -> None:
        response = self.post("/api/v1/auth/login", {"email": email, "password": password})
        user = (response.data or {}).get("user") or {}
        check(user.get("email") == email and user.get("role") == role, f"{self.label} login contract failed")
        check(bool(self.cookie), f"{self.label} login did not set session cookie")


def main() -> None:
    admin = ApiClient("admin")
    sahid = ApiClient("sahid")
    riya = ApiClient("riya")
    admin.login("admin@messtest.in", "Admin#12345", "ADMIN")
    sahid.login("sahid@messtest.in", "Resident#12345", "RESIDENT")
    riya.login("riya@messtest.in", "Resident#12345", "RESIDENT")

    baseline = sahid.get("/api/v1/payments?limit=100")
    deposits_before = baseline.meta.get("totalDepositsAllTime")
    pending_before = baseline.meta.get("pendingCount")
    check(isinstance(deposits_before, int), "approved-deposit baseline missing")
    check(isinstance(pending_before, int), "pending-payment baseline missing")

    ref = f"PHASE24-{uuid.uuid4().hex[:10]}"
    submitted = sahid.post_form(
        "/api/v1/payments",
        {
            "amount": "45.67",
            "method": "UPI",
            "reference": ref,
            "notes": "Phase 24 resident withdrawal acceptance",
            "idempotencyKey": str(uuid.uuid4()),
        },
    ).data or {}
    payment_id = submitted.get("id")
    check(isinstance(payment_id, str) and payment_id, "submitted payment id missing")
    check(submitted.get("status") == "PENDING", "submitted payment did not start PENDING")

    after_submit = sahid.get("/api/v1/payments?limit=100")
    check(after_submit.meta.get("pendingCount") == pending_before + 1, "pending count did not increase after submit")
    check(after_submit.meta.get("totalDepositsAllTime") == deposits_before, "PENDING payment changed approved deposits")

    # Ownership: another Resident must not be able to discover/control Sahid's row.
    riya.post(f"/api/v1/payments/{payment_id}/cancel", expected=404)

    withdrawn = sahid.post(f"/api/v1/payments/{payment_id}/cancel").data or {}
    check(withdrawn.get("status") == "VOIDED", "withdrawal did not close the payment as VOIDED")
    check(withdrawn.get("reviewedAt") is None, "resident withdrawal polluted Admin review timestamp")

    # Repeating withdrawal and trying to approve the closed row must both fail.
    sahid.post(f"/api/v1/payments/{payment_id}/cancel", expected=409)
    admin.post(f"/api/v1/admin/payments/{payment_id}/approve", expected=409)

    after_withdraw = sahid.get("/api/v1/payments?limit=100")
    row = next((item for item in (after_withdraw.data or []) if item.get("id") == payment_id), None)
    check(row is not None and row.get("status") == "VOIDED", "withdrawn payment disappeared from resident history")
    check(after_withdraw.meta.get("pendingCount") == pending_before, "pending count did not return to baseline")
    check(after_withdraw.meta.get("totalDepositsAllTime") == deposits_before, "withdrawal changed approved deposits")

    admin_voided = admin.get(f"/api/v1/admin/payments?status=VOIDED&q={ref}&limit=25").data or []
    check(any(item.get("id") == payment_id for item in admin_voided), "withdrawn payment disappeared from Admin history")

    print(json.dumps({"status": "passed", "paymentId": payment_id, "reference": ref}, sort_keys=True))


if __name__ == "__main__":
    try:
        main()
    except SmokeFailure as error:
        print(f"Phase 24 payment withdrawal smoke failed: {error}", file=os.sys.stderr)
        raise SystemExit(1)
