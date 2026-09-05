from pathlib import Path

path = Path("tests/seeded-auth-smoke.sh")
text = path.read_text()

replacements = [
    (
        '''ADMIN_EMAIL="${BOARDOPS_TEST_ADMIN_EMAIL:-admin@messtest.in}"\nADMIN_PASSWORD="${BOARDOPS_TEST_ADMIN_PASSWORD:-Admin#12345}"\nRESIDENT_EMAIL="${BOARDOPS_TEST_RESIDENT_EMAIL:-sahid@messtest.in}"\nRESIDENT_PASSWORD="${BOARDOPS_TEST_RESIDENT_PASSWORD:-Resident#12345}"''',
        '''# These are deliberately exact literals: this smoke validates the deterministic\n# development seed contract documented in docs/TESTING.md.\nADMIN_EMAIL="admin@messtest.in"\nADMIN_PASSWORD="Admin#12345"\nRESIDENT_EMAIL="sahid@messtest.in"\nRESIDENT_PASSWORD="Resident#12345"''',
    ),
    (
        '''login() {\n  local email="$1"\n  local password="$2"\n  local role="$3"\n  : >"$HEADER_FILE"\n  local status\n  status="$(curl --silent --show-error --max-time 10 \\\n    --dump-header "$HEADER_FILE" \\\n    --output "$BODY_FILE" \\\n    --write-out "%{http_code}" \\\n    -X POST "$BASE_URL/api/v1/auth/login" \\\n    -H "Origin: $BASE_URL" \\\n    -H "Content-Type: application/json" \\\n    --data "{\\\"email\\\":\\\"$email\\\",\\\"password\\\":\\\"$password\\\"}")"\n  [ "$status" = "200" ] || fail "$role login returned HTTP $status; expected 200"\n  assert_login_json "$role" "$email"\n  extract_session_cookie\n}''',
        '''login() {\n  local email="$1"\n  local password="$2"\n  local role="$3"\n  local payload\n  payload="$(python3 - "$email" "$password" <<'PY'\nimport json\nimport sys\nprint(json.dumps({"email": sys.argv[1], "password": sys.argv[2]}, separators=(",", ":")))\nPY\n)"\n  : >"$HEADER_FILE"\n  local status\n  status="$(curl --silent --show-error --max-time 10 \\\n    --dump-header "$HEADER_FILE" \\\n    --output "$BODY_FILE" \\\n    --write-out "%{http_code}" \\\n    -X POST "$BASE_URL/api/v1/auth/login" \\\n    -H "Origin: $BASE_URL" \\\n    -H "Content-Type: application/json" \\\n    --data-binary "$payload")"\n  [ "$status" = "200" ] || fail "$role login returned HTTP $status; expected 200"\n  assert_login_json "$role" "$email"\n  extract_session_cookie\n}''',
    ),
]

changed = False
for old, new in replacements:
    if new in text:
        continue
    if old not in text:
        raise SystemExit(f"expected pattern missing: {old[:120]!r}")
    text = text.replace(old, new, 1)
    changed = True

if changed:
    path.write_text(text)
    print("Phase 17 auth payload patch applied")
else:
    print("Phase 17 auth payload patch already applied")
