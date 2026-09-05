-- Phase 14 operational hardening: shared PostgreSQL rate-limit transport.
-- Keys are SHA-256 digests only; raw IP/email-bearing keys are never persisted.

CREATE TABLE "RateLimitBucket" (
  "keyHash" CHAR(64) NOT NULL,
  "count" INTEGER NOT NULL,
  "resetAt" TIMESTAMP(3) NOT NULL,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "RateLimitBucket_pkey" PRIMARY KEY ("keyHash")
);

CREATE INDEX "RateLimitBucket_resetAt_idx" ON "RateLimitBucket"("resetAt");
