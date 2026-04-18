import { PrismaClient } from '@prisma/client';
import { env, isDev } from './env';

declare global {
  // eslint-disable-next-line no-var
  var __prisma: PrismaClient | undefined;
}

// Singleton pattern to prevent multiple Prisma Client instances in dev
// (Next.js/ts-node-dev hot-reload creates new module instances)
function createPrismaClient(): PrismaClient {
  return new PrismaClient({
    log: isDev
      ? [
          { emit: 'event', level: 'query' },
          { emit: 'stdout', level: 'error' },
          { emit: 'stdout', level: 'warn' },
        ]
      : [{ emit: 'stdout', level: 'error' }],
    errorFormat: isDev ? 'pretty' : 'minimal',
  });
}

export const prisma: PrismaClient =
  global.__prisma ?? createPrismaClient();

if (isDev) {
  global.__prisma = prisma;

  // Log slow queries in development
  // @ts-expect-error — Prisma event typing
  prisma.$on('query', (e: { query: string; duration: number }) => {
    if (e.duration > 500) {
      console.warn(`[SLOW QUERY] ${e.duration}ms — ${e.query.slice(0, 200)}`);
    }
  });
}

const DB_MAX_RETRIES  = 5;
const DB_BASE_DELAY_MS = 2_000; // 2 s → 4 s → 8 s → 16 s → 32 s (exponential)

export async function connectDatabase(): Promise<void> {
  for (let attempt = 1; attempt <= DB_MAX_RETRIES; attempt++) {
    try {
      await prisma.$connect();
      console.log(`✅  Database connected [${env.NODE_ENV}]`);
      return;
    } catch (err) {
      if (attempt === DB_MAX_RETRIES) {
        // Exhausted all retries — bubble up to server.ts which calls process.exit(1)
        throw err;
      }
      const delayMs = DB_BASE_DELAY_MS * 2 ** (attempt - 1);
      console.warn(
        `⚠️  Database connection attempt ${attempt}/${DB_MAX_RETRIES} failed — ` +
        `retrying in ${delayMs / 1_000}s… (${(err as Error).message})`
      );
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
}

export async function disconnectDatabase(): Promise<void> {
  await prisma.$disconnect();
  console.log('🔌  Database disconnected');
}

export async function checkDatabaseHealth(): Promise<boolean> {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return true;
  } catch {
    return false;
  }
}
