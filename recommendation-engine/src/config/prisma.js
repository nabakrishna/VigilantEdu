/**
 * Prisma Client Singleton
 *
 * In dev, hot-reloading can spawn many PrismaClient instances and exhaust
 * the Postgres connection pool. We cache the instance on `global` in
 * non-production environments to guard against that. In production, a
 * single instance per process is correct.
 */

const { PrismaClient } = require('@prisma/client');

const logLevels =
  process.env.NODE_ENV === 'production'
    ? ['error', 'warn']
    : ['query', 'error', 'warn'];

function createPrismaClient() {
  return new PrismaClient({
    log: logLevels,
  });
}

let prisma;

if (process.env.NODE_ENV === 'production') {
  prisma = createPrismaClient();
} else {
  if (!global.__prisma) {
    global.__prisma = createPrismaClient();
  }
  prisma = global.__prisma;
}

module.exports = prisma;
