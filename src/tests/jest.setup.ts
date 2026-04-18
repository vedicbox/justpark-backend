import { connectDatabase, disconnectDatabase } from '../config/database';
import { connectRedis, disconnectRedis } from '../config/redis';

let infraReady = false;

beforeAll(async () => {
  if (infraReady) return;

  await connectDatabase();
  await connectRedis();
  infraReady = true;
}, 30_000);

afterAll(async () => {
  if (!infraReady) return;

  await disconnectDatabase();
  await disconnectRedis();
  infraReady = false;
}, 30_000);
