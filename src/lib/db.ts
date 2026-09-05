import { PrismaClient } from "@prisma/client";

const globalForPrisma = globalThis as unknown as {
  prisma: PrismaClient | undefined;
};

const logQueries = process.env.PRISMA_LOG_QUERIES === "1";
const prismaLog = logQueries
  ? (["query", "warn", "error"] as const)
  : process.env.NODE_ENV === "production"
    ? (["error"] as const)
    : (["warn", "error"] as const);

export const db =
  globalForPrisma.prisma ??
  new PrismaClient({
    // Raw SQL query logging is intentionally opt-in because production query
    // logs are noisy and may expose application data through parameters.
    log: [...prismaLog],
  });

if (process.env.NODE_ENV !== "production") globalForPrisma.prisma = db;
