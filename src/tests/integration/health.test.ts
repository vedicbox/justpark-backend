import request from 'supertest';
import { getTestApp, createTestUser, loginTestUser, disconnectTestPrisma } from '../helpers';

describe('GET /health', () => {
  let app: Awaited<ReturnType<typeof getTestApp>>;

  beforeAll(async () => {
    app = await getTestApp();
  });

  afterAll(async () => {
    await disconnectTestPrisma();
  });

  it('returns 200 with status ok when DB and Redis are healthy', async () => {
    const res = await request(app).get('/health');

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(res.body.services.database.status).toBe('ok');
    expect(res.body.services.redis.status).toBe('ok');
    expect(res.body.timestamp).toBeDefined();
    expect(res.body.uptime).toBeGreaterThan(0);
  });

  it('includes version field', async () => {
    const res = await request(app).get('/health');
    expect(res.body.version).toBeDefined();
  });
});

describe('GET /health/detailed', () => {
  let app: Awaited<ReturnType<typeof getTestApp>>;
  let adminTokens: { access_token: string };

  beforeAll(async () => {
    app = await getTestApp();
    const admin = await createTestUser({ role: 'admin' });
    adminTokens = await loginTestUser(app, admin);
  });

  it('returns 401 without auth token', async () => {
    const res = await request(app).get('/health/detailed');
    expect(res.status).toBe(401);
  });

  it('returns 403 for non-admin users', async () => {
    const user    = await createTestUser({ role: 'user' });
    const tokens  = await loginTestUser(app, user);
    const res = await request(app)
      .get('/health/detailed')
      .set('Authorization', `Bearer ${tokens.access_token}`);
    expect(res.status).toBe(403);
  });

  it('returns 200 with detailed stats for admin', async () => {
    const res = await request(app)
      .get('/health/detailed')
      .set('Authorization', `Bearer ${adminTokens.access_token}`);

    expect(res.status).toBe(200);
    expect(res.body.status).toBeDefined();
    expect(res.body.services.database).toBeDefined();
    expect(res.body.services.redis).toBeDefined();
    expect(res.body.queues).toBeDefined();
  });
});
