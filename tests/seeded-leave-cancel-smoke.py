#!/usr/bin/env python3
"""Production-standalone acceptance for Resident pending-leave cancellation.

This test mutates only the disposable deterministic seed database. It proves the
whole lifecycle through authenticated HTTP: ownership, PENDING -> CANCELLED,
terminal-state rejection, Admin queue visibility, and no meal-state mutation.
"""

from __future__ import annotations

import json
import os
import sys
from dataclasses import dataclass
from datetime import date, datetime, timedelta
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, build_opener

BASE_URL = os.environ.get("BOARDOPS_LEAVE_SMOKE_BASE_URL", "http://127.0.0.1:3104").rstrip("/")
ADMIN_EMAIL = "admin@messtest.in"
ADMIN_PASSWORD = "Admin#12345"
RESIDENT_EMAIL = "sahid@messtest.in"
RESIDENT_PASSWORD = "Resident#12345"
OTHER_RESIDENT_EMAIL = "riya@messtest.in"


class SmokeFailure(RuntimeError):
    pass


def check(condition: bool, message: str) -> None:
    if not condition:
        raise SmokeFailure(message)


def parse_iso(value: str) -> datetime:
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


def fingerprint(value: object) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=True)


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

    def request(self, method: str, path: str, *, body: object | None = None, expected: int = 200) -> Response:
        headers = {"Accept": "application/json"}
        if self.session_token:
            headers["Cookie"] = f"mes_session={self.session_token}"
        raw: bytes | None = None
        if method.upper() not in {"GET", "HEAD", "OPTIONS"}:
            headers["Origin"] = BASE_URL
        if body is not None:
            raw = json.dumps(body, separators=(",", ":")).encode("utf-8")
            headers["Content-Type"] = "application/json"

        req = Request(f"{BASE_URL}{path}", data=raw, headers=headers, method=method.upper())
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

    def login(self, email: str, password: str, role: str) -> None:
        response = self.post("/api/v1/auth/login", {"email": email, "password": password})
        user = (response.data or {}).get("user") or {}
        check(user.get("email") == email, f"{self.label} login returned wrong email")
        check(user.get("role") == role, f"{self.label} login returned wrong role")
        check(bool(self.session_token), f"{self.label} login did not emit mes_session")


def meal_state_view(rows: list[dict]) -> list[dict]:
    """Only authoritative ResidentMeal state fields; stable sorting avoids response-order noise."""
    values = []
    for row in rows:
        state = row.get("myState") or {}
        values.append(
            {
                "id": row.get("id"),
                "name": row.get("name"),
                "serviceDate": row.get("serviceDate"),
                "effectiveState": state.get("effectiveState"),
                "effectiveReason": state.get("effectiveReason"),
                "locked": state.get("locked"),
                "version": state.get("version"),
            }
        )
    return sorted(values, key=lambda item: (str(item["id"]), str(item["name"])))


def main() -> None:
    admin = ApiClient("admin")
    resident = ApiClient("resident")
    other_resident = ApiClient("other-resident")

    admin.login(ADMIN_EMAIL, ADMIN_PASSWORD, "ADMIN")
    resident.login(RESIDENT_EMAIL, RESIDENT_PASSWORD, "RESIDENT")
    other_resident.login(OTHER_RESIDENT_EMAIL, RESIDENT_PASSWORD, "RESIDENT")

    options = resident.get("/api/v1/meal-options").data or []
    check(options, "seed exposes no selectable meals")
    selectable_ids = {row.get("id") for row in options if row.get("id")}

    default_meals = resident.get("/api/v1/meals")
    today_text = default_meals.meta.get("today")
    check(isinstance(today_text, str), "meal calendar meta.today is missing")
    today = date.fromisoformat(today_text)
    range_from = today + timedelta(days=1)
    range_to = today + timedelta(days=28)
    response = resident.get(
        f"/api/v1/meals?{urlencode({'from': range_from.isoformat(), 'to': range_to.isoformat()})}"
    )
    server_now = parse_iso(response.meta.get("serverTime"))

    # Find one future unlocked selectable meal. The smoke does not rely on seed IDs/dates.
    target: dict | None = None
    for row in response.data or []:
        if row.get("serviceDate") is None or row.get("id") is None:
            continue
        if parse_iso(row.get("cutoffAt")) <= server_now + timedelta(minutes=2):
            continue
        # Match definition by visible name because resident meal rows intentionally do not expose definitionId.
        option = next((opt for opt in options if opt.get("name") == row.get("name")), None)
        if option and option.get("id") in selectable_ids:
            target = {"meal": row, "definition": option}
            break
    check(target is not None, "no future unlocked selectable meal found")

    target_date = target["meal"]["serviceDate"]
    definition_id = target["definition"]["id"]
    day_path = f"/api/v1/meals?{urlencode({'from': target_date, 'to': target_date})}"
    before_day = resident.get(day_path).data or []
    before_state = meal_state_view(before_day)

    created = resident.post(
        "/api/v1/leave-requests",
        {
            "startDate": target_date,
            "endDate": target_date,
            "reason": "Phase 23 resident cancellation acceptance",
            "mealScope": "SELECTED_MEALS",
            "mealDefinitionIds": [definition_id],
        },
    ).data or {}
    leave_id = created.get("id")
    check(isinstance(leave_id, str) and leave_id, "created leave id missing")
    check(created.get("status") == "PENDING", "new leave did not start in PENDING")

    admin_pending = admin.get("/api/v1/admin/leave-requests?status=PENDING&limit=100").data or []
    check(any(row.get("id") == leave_id for row in admin_pending), "Admin pending queue did not receive leave")

    # Ownership boundary: another Resident must see this as not found, not cancel it.
    other_resident.post(f"/api/v1/leave-requests/{leave_id}/cancel", expected=404)
    still_pending = resident.get("/api/v1/leave-requests").data or []
    owned_pending = next((row for row in still_pending if row.get("id") == leave_id), None)
    check(owned_pending is not None and owned_pending.get("status") == "PENDING", "foreign cancel changed leave")

    cancelled = resident.post(f"/api/v1/leave-requests/{leave_id}/cancel").data or {}
    check(cancelled.get("status") == "CANCELLED", "resident cancellation did not reach CANCELLED")

    resident_rows = resident.get("/api/v1/leave-requests").data or []
    resident_cancelled = next((row for row in resident_rows if row.get("id") == leave_id), None)
    check(
        resident_cancelled is not None and resident_cancelled.get("status") == "CANCELLED",
        "Resident leave history did not persist CANCELLED",
    )

    admin_cancelled = admin.get("/api/v1/admin/leave-requests?status=CANCELLED&limit=100").data or []
    check(any(row.get("id") == leave_id for row in admin_cancelled), "Admin CANCELLED filter did not show leave")

    # CANCELLED is terminal. Neither repeated resident action nor later Admin approval may rewrite it.
    resident.post(f"/api/v1/leave-requests/{leave_id}/cancel", expected=409)
    admin.post(
        f"/api/v1/admin/leave-requests/{leave_id}/approve",
        {"reason": "This must not approve a cancelled leave"},
        expected=409,
    )

    after_day = resident.get(day_path).data or []
    after_state = meal_state_view(after_day)
    check(
        fingerprint(after_state) == fingerprint(before_state),
        f"pending leave cancellation changed ResidentMeal state: before={before_state!r} after={after_state!r}",
    )

    print(
        json.dumps(
            {
                "status": "passed",
                "leaveId": leave_id,
                "targetDate": target_date,
                "selectedMeal": target["meal"].get("name"),
                "foreignCancel": "blocked",
                "residentStatus": "CANCELLED",
                "adminApproveAfterCancel": "blocked",
                "mealStateUnchanged": True,
            },
            sort_keys=True,
        )
    )


if __name__ == "__main__":
    try:
        main()
    except SmokeFailure as error:
        print(f"seeded leave cancellation smoke failed: {error}", file=sys.stderr)
        raise SystemExit(1)
    except Exception as error:
        print(f"seeded leave cancellation smoke crashed: {type(error).__name__}: {error}", file=sys.stderr)
        raise
