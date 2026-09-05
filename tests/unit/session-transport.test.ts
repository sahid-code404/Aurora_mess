import { afterEach, describe, expect, test } from "bun:test";
import { NextRequest } from "next/server";
import { bearerToken, previewBearerAuthEnabled } from "@/lib/auth/session";

const ORIGINAL_PREVIEW_BEARER = process.env.ENABLE_PREVIEW_BEARER_AUTH;

afterEach(() => {
  if (ORIGINAL_PREVIEW_BEARER === undefined) {
    delete process.env.ENABLE_PREVIEW_BEARER_AUTH;
  } else {
    process.env.ENABLE_PREVIEW_BEARER_AUTH = ORIGINAL_PREVIEW_BEARER;
  }
});

function requestWithBearer(token = "preview-token"): NextRequest {
  return new NextRequest("https://boardops.example.test/api/v1/auth/me", {
    headers: { authorization: `Bearer ${token}` },
  });
}

describe("session transport hardening", () => {
  test("preview bearer authentication is disabled by default", () => {
    delete process.env.ENABLE_PREVIEW_BEARER_AUTH;

    expect(previewBearerAuthEnabled()).toBe(false);
    expect(bearerToken(requestWithBearer())).toBeNull();
  });

  test("truthy-looking values do not accidentally enable bearer authentication", () => {
    for (const value of ["true", "yes", "on", "0", "2"]) {
      process.env.ENABLE_PREVIEW_BEARER_AUTH = value;
      expect(previewBearerAuthEnabled()).toBe(false);
      expect(bearerToken(requestWithBearer())).toBeNull();
    }
  });

  test("explicit value 1 enables preview bearer extraction", () => {
    process.env.ENABLE_PREVIEW_BEARER_AUTH = "1";

    expect(previewBearerAuthEnabled()).toBe(true);
    expect(bearerToken(requestWithBearer("ephemeral-preview-token"))).toBe("ephemeral-preview-token");
  });

  test("malformed authorization headers are rejected even when preview fallback is enabled", () => {
    process.env.ENABLE_PREVIEW_BEARER_AUTH = "1";

    const basic = new NextRequest("https://boardops.example.test/api/v1/auth/me", {
      headers: { authorization: "Basic abc123" },
    });
    const empty = new NextRequest("https://boardops.example.test/api/v1/auth/me", {
      headers: { authorization: "Bearer   " },
    });

    expect(bearerToken(basic)).toBeNull();
    expect(bearerToken(empty)).toBeNull();
  });
});
