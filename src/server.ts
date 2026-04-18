import http from 'http';
import type { Worker } from 'bullmq';
import { bootstrapEnv } from './config/env';

// ─────────────────────────────────────────────
// Bootstrap
// ─────────────────────────────────────────────
async function bootstrap(): Promise<void> {
  // ── 0. Secrets + env validation ──────────────────────────────────────────
  // Must be first. In production this fetches JUSTPARK_PROD_SECRETS from AWS
  // Secrets Manager and merges the values into process.env before Zod runs.
  // In dev / test it validates process.env directly (same as before).
  // All other imports are deferred below so no module touches env.* until
  // _env is populated.
  await bootstrapEnv();

  // ── Deferred imports (safe now that env is ready) ─────────────────────────
  const { logger }                           = await import('./utils/logger');
  const { env }                              = await import('./config/env');
  const { connectDatabase, disconnectDatabase } = await import('./config/database');
  const { connectRedis, disconnectRedis }    = await import('./config/redis');
  const { createApp }                        = await import('./app');
  const { startAllWorkers, stopAllWorkers }  = await import('./jobs/workers');
  const { setupSchedulers }                  = await import('./jobs/schedulers');
  const { initSocket }                       = await import('./socket');

  // 1. Connect to infrastructure
  try {
    await connectDatabase();
    await connectRedis();
  } catch (err) {
    logger.fatal({ err }, '❌  Failed to connect to infrastructure. Exiting.');
    process.exit(1);
  }

  // 2. Create Express app
  const app = createApp();
  const server = http.createServer(app);

  // 3a. Initialize Socket.IO (must be before workers so emit helpers work)
  initSocket(server);

  // 3b. Start BullMQ workers and register cron schedulers
  let workers: Worker[] = [];
  try {
    workers = startAllWorkers();
    await setupSchedulers();
  } catch (err) {
    logger.error({ err }, '⚠️  Failed to start job workers/schedulers (non-fatal)');
  }

  // 4. Start listening
  server.listen(env.PORT, () => {
    logger.info(
      {
        port:    env.PORT,
        env:     env.NODE_ENV,
        apiBase: `/api/${env.API_VERSION}`,
        queues:  '/admin/queues',
      },
      `🚀  JustPark API started on port ${env.PORT} [${env.NODE_ENV}]`
    );
  });

  // ─────────────────────────────────────────────
  // Graceful Shutdown
  // ─────────────────────────────────────────────
  let isShuttingDown = false;

  async function gracefulShutdown(signal: string): Promise<void> {
    if (isShuttingDown) return;
    isShuttingDown = true;

    logger.info(`📴  ${signal} received — starting graceful shutdown`);

    // 1. Stop accepting new HTTP connections
    server.close(async (err) => {
      if (err) {
        logger.error({ err }, 'Error closing HTTP server');
      } else {
        logger.info('✅  HTTP server closed');
      }

      // 2. Stop BullMQ workers (wait for active jobs to complete)
      try {
        await stopAllWorkers(workers);
      } catch (workerErr) {
        logger.error({ err: workerErr }, 'Error stopping workers');
      }

      // 3. Close database connections
      try {
        await disconnectDatabase();
      } catch (dbErr) {
        logger.error({ err: dbErr }, 'Error disconnecting database');
      }

      // 4. Close Redis connections
      try {
        await disconnectRedis();
      } catch (redisErr) {
        logger.error({ err: redisErr }, 'Error disconnecting Redis');
      }

      logger.info('👋  Graceful shutdown complete');
      process.exit(err ? 1 : 0);
    });

    // Force-kill if graceful shutdown takes too long (15 seconds)
    setTimeout(() => {
      logger.error('⚠️   Forced shutdown after 15s timeout');
      process.exit(1);
    }, 15_000).unref();
  }

  // Handle termination signals
  process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
  process.on('SIGINT', () => gracefulShutdown('SIGINT'));

  // ─────────────────────────────────────────────
  // Unhandled Errors
  // ─────────────────────────────────────────────
  process.on('uncaughtException', (err) => {
    logger.fatal({ err }, '💥  Uncaught exception — shutting down');
    gracefulShutdown('uncaughtException').catch(() => process.exit(1));
  });

  process.on('unhandledRejection', (reason) => {
    logger.fatal({ reason }, '💥  Unhandled promise rejection — shutting down');
    gracefulShutdown('unhandledRejection').catch(() => process.exit(1));
  });
}

bootstrap();
