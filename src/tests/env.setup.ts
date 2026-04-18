/**
 * Loaded by Jest `setupFiles` — runs before any test module is imported.
 * Sets NODE_ENV=test and loads .env.test so env validation in config/env.ts passes.
 */
import path from 'path';
import dotenv from 'dotenv';

const rootEnvPath = path.resolve(__dirname, '../../.env');
const testEnvPath = path.resolve(__dirname, '../../.env.test');

// Load local development defaults first so tests use the same DB / Redis services.
dotenv.config({ path: rootEnvPath, override: false });

const baseDatabaseUrl = process.env['DATABASE_URL'];
const baseRedisUrl = process.env['REDIS_URL'];

// Override with test-specific env before any module loads env.ts
process.env['NODE_ENV'] = 'test';
dotenv.config({ path: testEnvPath, override: true });

if (baseDatabaseUrl) {
  process.env['DATABASE_URL'] = baseDatabaseUrl;
}

if (baseRedisUrl) {
  process.env['REDIS_URL'] = baseRedisUrl;

  const redisUrl = new URL(baseRedisUrl);
  process.env['REDIS_HOST'] = redisUrl.hostname;
  process.env['REDIS_PORT'] = redisUrl.port || '6379';
  process.env['REDIS_PASSWORD'] = redisUrl.password || '';
  process.env['REDIS_DB'] = redisUrl.pathname.replace('/', '') || '0';
}
