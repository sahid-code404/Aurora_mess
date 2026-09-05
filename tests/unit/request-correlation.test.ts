import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { NextRequest } from "next/server";
import { route } from "@/lib/auth/guard";
import { ApiError, CODES } from "@/lib/errors";

const ORIGINAL_LOGGING = process.env.API_REQUEST_LOGGING;

beforeEach(() => {
  process.env.API_REQUEST_LOGGING = "0";
});

afterEach(() => {
  if (ORIGINAL_LOGGING === undefined) delete process.env.API_REQUEST_LOGGING;
  else process.env.API_REQUEST_LOGGING = ORIGINAL_LOGGING;
});

describe("request correlation", () => {
  test("successful API responses expose the same request id in header and envelope", async () => {
    const handler = route({ auth: "PUBLIC" }, async (ctx) => ({
      data: { handlerRequestId: ctx.requestId },
    }));

    const response = await handler(
      new NextRequest("https://boardops.example.test/api/v1/test"),
      { params: Promise.resolve({}) }
    );
    const body = (await response.json()) as {
      ok: boolean;
      data: { handlerRequestId: string };
      meta: { requestId: string };
    };

    const headerId = response.headers.get("x-request-id");
    expect(response.status).toBe(200);
    expect(headerId).toBeTruthy();
    expect(body.meta.requestId).toBe(headerId);
    expect(body.data.handlerRequestId).toBe(headerId);
  });

  test("error responses expose the same request id in header and error envelope", async () => {
    const handler = route({ auth: "PUBLIC" }, async () => {
      throw new ApiError(CODES.VALIDATION_FAILED, "Synthetic validation failure", 400);
    });

    const response = await handler(
      new NextRequest("https://boardops.example.test/api/v1/test", { method: "GET" }),
      { params: Promise.resolve({}) }
    );
    const body = (await response.json()) as {
      ok: boolean;
      error: { code: string; requestId: string };
    };

    const headerId = response.headers.get("x-request-id");
    expect(response.status).toBe(400);
    expect(headerId).toBeTruthy();
    expect(body.error.code).toBe(CODES.VALIDATION_FAILED);
    expect(body.error.requestId).toBe(headerId);
  });
});
