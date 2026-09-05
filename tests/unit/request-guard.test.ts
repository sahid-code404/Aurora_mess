import { afterEach, describe, expect, test } from "bun:test";
import { NextRequest } from "next/server";
import { assertCsrfSafeRequest } from "@/lib/auth/guard";

const ORIGINAL_PREVIEW_BEARER = process.env.ENABLE_PREVIEW_BEARER_AUTH;

afterEach(() => {
  if (ORIGINAL_PREVIEW_BEARER === undefined) {
    delete process.env.ENABLE_PREVIEW_BEARER_AUTH;
  } else {
    process.env.ENABLE_PREVIEW_BEARER_AUTH = ORIGINAL_PREVIEW_BEARER;
  }
});

function request(
  method: string,
  headers?: Record<string, string>,
  url = "https://boardops.example.test/api/v1/admin/payments"
): NextRequest {
  return new NextRequest(url, {
    method,
    headers,
  });
}

describe("central request CSRF guard", () => {
  test("safe read methods are not blocked by cross-site metadata", () => {
    expect(() =>
      assertCsrfSafeRequest(
        request("GET", {
          origin: "https://evil.example.test",
          "sec-fetch-site": "cross-site",
        })
      )
    ).not.toThrow();
  });

  test("same-origin cookie mutations are accepted", () => {
    expect(() =>
      assertCsrfSafeRequest(
        request("POST", {
          origin: "https://boardops.example.test",
          referer: "https://boardops.example.test/admin/payments",
          "sec-fetch-site": "same-origin",
        })
      )
    ).not.toThrow();
  });

  test("standalone requests use the HTTP Host when Next reconstructs a different URL host", () => {
    expect(() =>
      assertCsrfSafeRequest(
        request(
          "POST",
          {
            host: "127.0.0.1:3100",
            origin: "http://127.0.0.1:3100",
            "sec-fetch-site": "same-origin",
          },
          "http://localhost:3000/api/v1/auth/login"
        )
      )
    ).not.toThrow();
  });

  test("TLS-terminating proxy uses preserved Host plus forwarded protocol", () => {
    expect(() =>
      assertCsrfSafeRequest(
        request(
          "POST",
          {
            host: "boardops.example.test",
            "x-forwarded-proto": "https",
            origin: "https://boardops.example.test",
            referer: "https://boardops.example.test/app",
            "sec-fetch-site": "same-origin",
          },
          "http://127.0.0.1:3000/api/v1/auth/login"
        )
      )
    ).not.toThrow();
  });

  test("browser-classified cross-site mutations are rejected", () => {
    expect(() =>
      assertCsrfSafeRequest(
        request("POST", {
          origin: "https://evil.example.test",
          "sec-fetch-site": "cross-site",
        })
      )
    ).toThrow("Cross-site requests are not allowed");
  });

  test("mismatched Origin or Referer is rejected", () => {
    expect(() =>
      assertCsrfSafeRequest(request("PATCH", { origin: "https://evil.example.test" }))
    ).toThrow("Cross-site requests are not allowed");

    expect(() =>
      assertCsrfSafeRequest(
        request("DELETE", { referer: "https://evil.example.test/forged-form" })
      )
    ).toThrow("Cross-site requests are not allowed");
  });

  test("forwarded protocol cannot make a foreign Origin match the destination Host", () => {
    expect(() =>
      assertCsrfSafeRequest(
        request(
          "POST",
          {
            host: "boardops.example.test",
            "x-forwarded-proto": "https",
            origin: "https://evil.example.test",
          },
          "http://127.0.0.1:3000/api/v1/admin/payments"
        )
      )
    ).toThrow("Cross-site requests are not allowed");
  });

  test("headerless trusted tooling remains compatible", () => {
    expect(() => assertCsrfSafeRequest(request("POST"))).not.toThrow();
  });

  test("explicit preview bearer requests do not rely on ambient cookies", () => {
    process.env.ENABLE_PREVIEW_BEARER_AUTH = "1";

    expect(() =>
      assertCsrfSafeRequest(
        request("POST", {
          authorization: "Bearer in-memory-preview-token",
          origin: "https://preview-host.example.test",
          "sec-fetch-site": "cross-site",
        })
      )
    ).not.toThrow();
  });
});
