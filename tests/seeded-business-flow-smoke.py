#!/usr/bin/env python3
"""Production-standalone acceptance flow over the deterministic development seed.

This intentionally exercises the HTTP surface exactly as Admin and Resident do.
It mutates only the disposable CI seed database and must never target production.
"""

from __future__ import annotations

import json
import os
import sys
import uuid
from collections import defaultdict
from dataclasses import dataclass
from datetime import date, datetime, timedelta, timezone
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, build_opener

BASE_URL = os.environ.get("BOARDOPS_BUSINESS_SMOKE_BASE_URL", "http://127.0.0.1:3102").rstrip("/")
ADMIN_EMAIL = "admin@messtest.in"
ADMIN_PASSWORD = "Admin#12345"
RESIDENT_EMAIL = "sahid@messtest.in"
RESIDENT_PASSWORD = "Resident#12345"


class SmokeFailure(RuntimeError):
    pass


def check(condition: bool, message: str) -> None:
    if not condition:
        raise SmokeFailure(message)


def parse_iso(value: str) -> datetime:
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


def json_fingerprint(value: object) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=True)


def multipart(fields: dict[str, str]) -> tuple[bytes, str]:
    boundary = f"----BoardOpsPhase19{uuid.uuid4().hex}"
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
        raw: bytes | None = None
        if method.upper() not in {"GET", "HEAD", "OPTIONS"}:
            headers["Origin"] = BASE_URL
        if body is not None and form is not None:
            raise SmokeFailure("test harness cannot send JSON and multipart together")
        if body is not None:
            raw = json.dumps(body, separators=(",", ":")).encode("utf-8")
            headers["Content-Type"] = "application/json"
        elif form is not None:
            raw, content_type = multipart(form)
            headers["Content-Type"] = content_type

        req = Request(url, data=raw, headers=headers, method=method.upper())
        set_cookies: list[str] = []
        try:
            with self.opener.open(req, timeout=15) as response:
                status = response.status
                set_cookies = response.headers.get_all("Set-Cookie") or []
                text = response.read().decode("utf-8")
        except HTTPError as error:
            status = error.code
            set_cookies = error.headers.get_all("Set-Cookie") or []
            text = error.read().decode("utf-8", errors="replace")
        except URLError as error:
            raise SmokeFailure(f"{self.label} {method} {path} failed to connect: {error}") from error

        for cookie in set_cookies:
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
            check(payload.get("ok") is True, f"{self.label} {method} {path} did not return ok=true: {payload!r}")
        return Response(status, payload)

    def get(self, path: str, *, expected: int = 200) -> Response:
        return self.request("GET", path, expected=expected)

    def post(self, path: str, body: object | None = None, *, expected: int = 200) -> Response:
        return self.request("POST", path, body=body if body is not None else {}, expected=expected)

    def post_form(self, path: str, fields: dict[str, str], *, expected: int = 200) -> Response:
        return self.request("POST", path, form=fields, expected=expected)

    def login(self, email: str, password: str, role: str) -> dict:
        response = self.post("/api/v1/auth/login", {"email": email, "password": password})
        data = response.data or {}
        user = data.get("user") or {}
        check(user.get("email") == email, f"{self.label} login returned wrong email")
        check(user.get("role") == role, f"{self.label} login returned wrong role")
        check("sessionToken" not in json_fingerprint(response.payload), f"{self.label} login leaked sessionToken")
        check(bool(self.session_token), f"{self.label} login did not emit mes_session")
        me = self.get("/api/v1/auth/me").data or {}
        check((me.get("user") or {}).get("role") == role, f"{self.label} session role mismatch")
        return me


def bill_immutable_view(bill: dict) -> dict:
    """Fields that billing/payment flows are not allowed to rewrite historically."""
    return {
        "id": bill.get("id"),
        "billNumber": bill.get("billNumber"),
        "period": bill.get("period"),
        "residentMealCount": bill.get("residentMealCount"),
        "guestMealCount": bill.get("guestMealCount"),
        "mealChargeMinor": bill.get("mealChargeMinor"),
        "guestChargeMinor": bill.get("guestChargeMinor"),
        "subtotalMinor": bill.get("subtotalMinor"),
        "dueDate": bill.get("dueDate"),
        "generatedAt": bill.get("generatedAt"),
        "snapshotId": bill.get("snapshotId"),
        "lines": bill.get("lines"),
    }


def meal_by_name(rows: list[dict], name: str) -> dict:
    for row in rows:
        if row.get("name") == name:
            return row
    raise SmokeFailure(f"meal {name!r} disappeared from target date")


def main() -> None:
    admin = ApiClient("admin")
    resident = ApiClient("resident")

    admin_me = admin.login(ADMIN_EMAIL, ADMIN_PASSWORD, "ADMIN")
    resident_me = resident.login(RESIDENT_EMAIL, RESIDENT_PASSWORD, "RESIDENT")
    resident_user = resident_me.get("user") or {}
    resident_id = resident_user.get("id")
    check(isinstance(resident_id, str) and resident_id, "resident id missing from /auth/me")
    check(
        (admin_me.get("user") or {}).get("institutionId") == resident_user.get("institutionId"),
        "seeded Admin and Resident are not in the same institution",
    )

    # ------------------------------------------------------------------
    # Historical billing baseline: mutable settlement fields are excluded;
    # snapshot/charge/line provenance must not change during current flows.
    # ------------------------------------------------------------------
    bill_rows = resident.get("/api/v1/bills?limit=100").data or []
    check(len(bill_rows) > 0, "seed must contain at least one historical resident bill")
    historical_bill = bill_rows[0]
    historical_bill_id = historical_bill.get("id")
    check(isinstance(historical_bill_id, str), "historical bill id missing")
    historical_before = bill_immutable_view(historical_bill)

    # ------------------------------------------------------------------
    # Discover a future unlocked day with three distinct selectable meals.
    # No database ids/dates are hardcoded into the acceptance test.
    # ------------------------------------------------------------------
    options = resident.get("/api/v1/meal-options").data or []
    option_by_name = {item.get("name"): item for item in options if item.get("name") and item.get("id")}
    check(len(option_by_name) >= 3, "seed must expose at least three selectable resident meal definitions")

    default_meals = resident.get("/api/v1/meals")
    today_text = default_meals.meta.get("today")
    check(isinstance(today_text, str), "meal calendar did not return meta.today")
    today = date.fromisoformat(today_text)
    range_from = today + timedelta(days=1)
    range_to = today + timedelta(days=21)
    query = urlencode({"from": range_from.isoformat(), "to": range_to.isoformat()})
    future_response = resident.get(f"/api/v1/meals?{query}")
    future_rows = future_response.data or []
    server_now = parse_iso(future_response.meta.get("serverTime"))
    grouped: dict[str, list[dict]] = defaultdict(list)
    for row in future_rows:
        if row.get("name") not in option_by_name:
            continue
        cutoff = parse_iso(row.get("cutoffAt"))
        if cutoff <= server_now + timedelta(minutes=2):
            continue
        grouped[row.get("serviceDate")].append(row)

    target_date: str | None = None
    target_meals: list[dict] = []
    for service_date in sorted(grouped):
        unique: dict[str, dict] = {}
        for row in grouped[service_date]:
            unique.setdefault(row.get("name"), row)
        if len(unique) >= 3:
            target_date = service_date
            target_meals = sorted(unique.values(), key=lambda item: (item.get("serviceWindow") or {}).get("startAt", ""))[:3]
            break
    check(target_date is not None and len(target_meals) == 3, "no future unlocked day with three distinct meals was found")

    leave_meal, calendar_meal, guest_meal = target_meals
    leave_definition_id = option_by_name[leave_meal["name"]]["id"]
    calendar_definition_id = option_by_name[calendar_meal["name"]]["id"]
    month_meals_before_guest = future_response.meta.get("mealsOnMonth")
    check(isinstance(month_meals_before_guest, int), "mealsOnMonth counter missing")

    # ------------------------------------------------------------------
    # Guest meals are a separate domain and idempotent. Booking guests must
    # not change the resident's own confirmed meal total.
    # ------------------------------------------------------------------
    guest_key = str(uuid.uuid4())
    guest_payload = {
        "mealInstanceId": guest_meal["mealInstanceId"],
        "quantity": 2,
        "note": "Phase 19 guest separation acceptance",
        "idempotencyKey": guest_key,
    }
    guest_created = resident.post("/api/v1/guest-meals", guest_payload)
    guest_row = guest_created.data or {}
    check(guest_row.get("status") == "CONFIRMED", "guest meal did not auto-confirm")
    check(guest_row.get("quantity") == 2, "guest meal quantity changed")
    guest_replay = resident.post("/api/v1/guest-meals", guest_payload)
    check((guest_replay.data or {}).get("id") == guest_row.get("id"), "guest idempotency replay created a different row")
    check(guest_replay.meta.get("idempotentReplay") is True, "guest idempotency replay was not reported")
    guest_list = resident.get(
        f"/api/v1/guest-meals?{urlencode({'from': target_date, 'to': target_date})}"
    )
    matching_guests = [row for row in (guest_list.data or []) if row.get("id") == guest_row.get("id")]
    check(len(matching_guests) == 1, "guest idempotency produced duplicate persisted rows")
    target_meals_after_guest = resident.get(
        f"/api/v1/meals?{urlencode({'from': target_date, 'to': target_date})}"
    )
    check(
        target_meals_after_guest.meta.get("mealsOnMonth") == month_meals_before_guest,
        "guest booking changed resident mealsOnMonth",
    )

    # ------------------------------------------------------------------
    # Selected-meal leave: only the chosen definition becomes ON_LEAVE.
    # ------------------------------------------------------------------
    leave_request = resident.post(
        "/api/v1/leave-requests",
        {
            "startDate": target_date,
            "endDate": target_date,
            "reason": "Phase 19 selected-meal leave acceptance",
            "mealScope": "SELECTED_MEALS",
            "mealDefinitionIds": [leave_definition_id],
        },
    ).data or {}
    leave_id = leave_request.get("id")
    check(isinstance(leave_id, str), "leave request id missing")
    check(leave_request.get("mealScope") == "SELECTED_MEALS", "leave request lost selected-meal scope")
    approved_leave = admin.post(
        f"/api/v1/admin/leave-requests/{leave_id}/approve",
        {"reason": "Phase 19 acceptance approval"},
    ).data or {}
    check(approved_leave.get("status") == "APPROVED", "selected-meal leave was not approved")

    leave_day = resident.get(f"/api/v1/meals?{urlencode({'from': target_date, 'to': target_date})}").data or []
    leave_state = (meal_by_name(leave_day, leave_meal["name"]).get("myState") or {})
    untouched_after_leave = (meal_by_name(leave_day, calendar_meal["name"]).get("myState") or {})
    check(
        leave_state.get("effectiveState") == "ON_LEAVE" and leave_state.get("effectiveReason") == "LEAVE_APPROVED",
        f"selected leave meal was not ON_LEAVE: {leave_state!r}",
    )
    check(
        untouched_after_leave.get("effectiveReason") != "LEAVE_APPROVED",
        "selected leave incorrectly affected an unselected meal",
    )

    # ------------------------------------------------------------------
    # Selected calendar disable: only the second definition is disabled;
    # the leave meal remains on leave and a third meal is not calendar-disabled.
    # ------------------------------------------------------------------
    calendar_event = admin.post(
        "/api/v1/admin/calendar",
        {
            "name": f"Phase 19 selected disable {uuid.uuid4().hex[:8]}",
            "description": "Production acceptance event",
            "startDate": target_date,
            "endDate": target_date,
            "type": "CUSTOM",
            "disableMeals": True,
            "mealScope": "SELECTED_MEALS",
            "mealDefinitionIds": [calendar_definition_id],
        },
    ).data or {}
    check(calendar_event.get("mealScope") == "SELECTED_MEALS", "calendar event lost selected-meal scope")

    calendar_day = resident.get(f"/api/v1/meals?{urlencode({'from': target_date, 'to': target_date})}").data or []
    leave_after_calendar = (meal_by_name(calendar_day, leave_meal["name"]).get("myState") or {})
    calendar_state = (meal_by_name(calendar_day, calendar_meal["name"]).get("myState") or {})
    third_state = (meal_by_name(calendar_day, guest_meal["name"]).get("myState") or {})
    check(leave_after_calendar.get("effectiveState") == "ON_LEAVE", "calendar event overwrote unrelated leave state")
    check(
        calendar_state.get("effectiveState") == "NOT_AVAILABLE"
        and calendar_state.get("effectiveReason") == "CALENDAR_DISABLED",
        f"selected calendar meal was not disabled: {calendar_state!r}",
    )
    check(third_state.get("effectiveReason") != "CALENDAR_DISABLED", "calendar event affected an unselected third meal")

    # ------------------------------------------------------------------
    # GENERAL and MARKET_PURCHASE remain distinct task types. Exercise the
    # resident ASSIGNED -> ACCEPTED -> IN_PROGRESS path for both; the market
    # task additionally submits priced items and Admin approval creates one
    # auditable Expense + balanced journal reference.
    # ------------------------------------------------------------------
    suffix = uuid.uuid4().hex[:10]
    general_description = f"Phase19 general water-container check {suffix}"
    general_task = admin.post(
        "/api/v1/admin/tasks",
        {
            "taskType": "GENERAL",
            "description": general_description,
            "assignedResidentId": resident_id,
            "dueDate": target_date,
            "notes": "Normal task acceptance path",
            "items": [],
        },
    ).data or {}
    check(general_task.get("taskType") == "GENERAL" and general_task.get("status") == "ASSIGNED", "GENERAL task contract failed")
    general_id = general_task.get("id")
    check(resident.post(f"/api/v1/tasks/{general_id}/accept").data.get("status") == "ACCEPTED", "GENERAL task accept failed")
    check(resident.post(f"/api/v1/tasks/{general_id}/start").data.get("status") == "IN_PROGRESS", "GENERAL task start failed")

    market_description = f"Phase19 market rice purchase {suffix}"
    market_task = admin.post(
        "/api/v1/admin/tasks",
        {
            "taskType": "MARKET_PURCHASE",
            "description": market_description,
            "assignedResidentId": resident_id,
            "dueDate": target_date,
            "notes": "Market task acceptance path",
            "estimatedAmountMinor": "100.00",
            "items": [
                {
                    "itemName": f"Phase19 rice {suffix}",
                    "expectedQuantity": 2,
                    "unit": "kg",
                    "estimatedUnitPriceMinor": "50.00",
                }
            ],
        },
    ).data or {}
    check(market_task.get("taskType") == "MARKET_PURCHASE" and market_task.get("status") == "ASSIGNED", "MARKET task contract failed")
    market_id = market_task.get("id")
    resident.post(f"/api/v1/tasks/{market_id}/accept")
    resident.post(f"/api/v1/tasks/{market_id}/start")
    submission = resident.post_form(
        f"/api/v1/tasks/{market_id}/submission",
        {
            "comment": "Phase 19 market submission",
            "itemsJson": json.dumps(
                [
                    {
                        "itemName": f"Phase19 rice {suffix}",
                        "quantity": 2,
                        "unit": "kg",
                        "unitPrice": "50.00",
                    }
                ],
                separators=(",", ":"),
            ),
        },
    ).data or {}
    check(submission.get("status") == "SUBMITTED", "market submission did not reach SUBMITTED")
    check(submission.get("claimedTotalMinor") == 10_000, "market submission total was not server-computed to ₹100.00")
    submission_id = submission.get("id")
    market_approved = admin.post(
        f"/api/v1/admin/task-submissions/{submission_id}/approve",
        {"reason": "Phase 19 verified purchase"},
    ).data or {}
    check(market_approved.get("status") == "APPROVED", "market task submission approval failed")
    check(market_approved.get("totalMinor") == 10_000, "approved market expense total changed")
    check(bool(market_approved.get("expenseId")), "market approval did not create an expense")
    check(bool(market_approved.get("journalId")), "market approval did not post a journal")

    task_search = admin.get(f"/api/v1/admin/tasks?{urlencode({'q': suffix, 'limit': '25'})}").data or []
    by_description = {task.get("description"): task for task in task_search}
    check(by_description.get(general_description, {}).get("status") == "IN_PROGRESS", "GENERAL task was not independently preserved")
    check(by_description.get(market_description, {}).get("status") == "APPROVED", "MARKET task did not finish independently")
    check(
        (by_description.get(market_description, {}).get("submission") or {}).get("expenseId") == market_approved.get("expenseId"),
        "market task did not retain its approved expense link",
    )

    # ------------------------------------------------------------------
    # Resident submits a payment; it is pending until Admin approval, then the
    # resident deposit total increases exactly once. Also prove idempotency.
    # ------------------------------------------------------------------
    payments_before = resident.get("/api/v1/payments?limit=100")
    deposits_before = payments_before.meta.get("totalDepositsAllTime")
    check(isinstance(deposits_before, int), "resident deposit baseline missing")
    payment_key = str(uuid.uuid4())
    payment_fields = {
        "amount": "123.45",
        "method": "UPI",
        "reference": f"PHASE19-{suffix}",
        "notes": "Phase 19 production acceptance payment",
        "idempotencyKey": payment_key,
    }
    submitted_payment = resident.post_form("/api/v1/payments", payment_fields)
    payment = submitted_payment.data or {}
    payment_id = payment.get("id")
    check(payment.get("status") == "PENDING", "resident payment bypassed Admin review")
    payment_replay = resident.post_form("/api/v1/payments", payment_fields)
    check((payment_replay.data or {}).get("id") == payment_id, "payment idempotency replay created a different payment")
    check(payment_replay.meta.get("idempotentReplay") is True, "payment replay was not marked idempotent")

    approved_payment = admin.post(f"/api/v1/admin/payments/{payment_id}/approve").data or {}
    check(approved_payment.get("status") == "APPROVED", "Admin payment approval failed")
    payments_after = resident.get("/api/v1/payments?limit=100")
    after_rows = payments_after.data or []
    matching_payment = next((row for row in after_rows if row.get("id") == payment_id), None)
    check(matching_payment is not None and matching_payment.get("status") == "APPROVED", "resident did not observe approved payment")
    check(
        payments_after.meta.get("totalDepositsAllTime") == deposits_before + 12_345,
        "approved payment did not increase authoritative resident deposits exactly once",
    )

    # ------------------------------------------------------------------
    # Formula preview evaluates real variables but does not activate/mutate a
    # formula. Capture the formula definition view before and after preview.
    # ------------------------------------------------------------------
    formula_before = admin.get("/api/v1/admin/formulas").data
    formula_preview = admin.post(
        "/api/v1/admin/formulas/preview",
        {
            "mode": "FORMULA",
            "source": "meal_charge = (total_market_expense - total_guest_income) / total_resident_meals",
            "outputVariableKey": "meal_charge",
        },
    ).data or {}
    check(formula_preview.get("outputVariableKey") == "meal_charge", "formula preview output key mismatch")
    check(bool(formula_preview.get("humanPreview")), "formula preview did not return a human preview")
    example = formula_preview.get("example") or {}
    check(example.get("divideByZero") is False, "seeded formula preview unexpectedly divided by zero")
    variable_names = {item.get("name") for item in (example.get("variables") or [])}
    check(
        {"total_market_expense", "total_guest_income", "total_resident_meals"}.issubset(variable_names),
        "formula preview did not resolve the expected system variables",
    )
    formula_after = admin.get("/api/v1/admin/formulas").data
    check(json_fingerprint(formula_after) == json_fingerprint(formula_before), "formula preview mutated formula definitions")

    # ------------------------------------------------------------------
    # Current-period actions and later payment settlement may change bill
    # payment/status fields, but immutable historical billing provenance must
    # remain byte-for-byte identical for the selected seeded bill.
    # ------------------------------------------------------------------
    bill_rows_after = resident.get("/api/v1/bills?limit=100").data or []
    historical_after = next((bill for bill in bill_rows_after if bill.get("id") == historical_bill_id), None)
    check(historical_after is not None, "historical bill disappeared during current-period flows")
    check(
        json_fingerprint(bill_immutable_view(historical_after)) == json_fingerprint(historical_before),
        "historical bill provenance changed during current-period business flows",
    )

    print(
        json.dumps(
            {
                "status": "passed",
                "targetDate": target_date,
                "selectedLeaveMeal": leave_meal["name"],
                "selectedCalendarMeal": calendar_meal["name"],
                "guestMeal": guest_meal["name"],
                "generalTaskId": general_id,
                "marketTaskId": market_id,
                "marketExpenseId": market_approved.get("expenseId"),
                "paymentId": payment_id,
                "historicalBillId": historical_bill_id,
            },
            sort_keys=True,
        )
    )


if __name__ == "__main__":
    try:
        main()
    except SmokeFailure as error:
        print(f"seeded business-flow smoke failed: {error}", file=sys.stderr)
        raise SystemExit(1)
    except Exception as error:  # preserve a useful exception class/message in CI
        print(f"seeded business-flow smoke crashed: {type(error).__name__}: {error}", file=sys.stderr)
        raise
