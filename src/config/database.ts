// ==============================================================================
// RESPONSIBLE MEMBER: Member A (Team Leader & System Architect)
// FEATURE: Database Connection & Prisma Client Singleton
//
// TODO: [Member A]
// 1. Manage Prisma database lifecycle and connection pools.
// 2. Handle graceful disconnects on SIGINT / SIGTERM signals.
// 3. Configure query logging based on NODE_ENV.
// ==============================================================================

import { PrismaClient } from "@prisma/client";

declare global {
  // eslint-disable-next-line no-var
  var prismaGlobal: PrismaClient | undefined;
}

export const prisma: PrismaClient =
  globalThis.prismaGlobal ??
  new PrismaClient({
    log: process.env.NODE_ENV === "development" ? ["query", "error", "warn"] : ["error"],
  });

if (process.env.NODE_ENV !== "production") {
  globalThis.prismaGlobal = prisma;
}

export async function connectDatabase(): Promise<void> {
  try {
    await prisma.$connect();
    console.log("[Database] Connected successfully to database via Prisma.");
  } catch (error) {
    console.error("[Database] Failed to connect to database:", error);
    process.exit(1);
  }
}

export async function disconnectDatabase(): Promise<void> {
  await prisma.$disconnect();
  console.log("[Database] Prisma connection closed.");
}
