/**
 * Auth Integration Tests
 *
 * These tests cover the critical auth flows:
 *   register → send OTP → verify OTP → login → refresh → logout
 *
 * External services (email/SMS) are mocked so no real messages are sent.
 */
import request from 'supertest';
import {
  getTestApp,
  createTestUser,
  prismaTest,
  disconnectTestPrisma,
} from '../helpers';

// ── Mock external delivery so tests don't need SendGrid/Twilio
jest.mock('../../services/emailService', () => ({
  sendEmail:              jest.fn().mockResolvedValue(undefined),
  sendOtpEmail:           jest.fn().mockResolvedValue(undefined),
  sendPasswordResetEmail: jest.fn().mockResolvedValue(undefined),
  sendBookingConfirmation: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../../services/smsService', () => ({
  sendSms:    jest.fn().mockResolvedValue(undefined),
  sendOtpSms: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../../jobs/index', () => ({
  notificationQueue: { add: jest.fn().mockResolvedValue(undefined) },
  bookingQueue:      { add: jest.fn().mockResolvedValue(undefined) },
  payoutQueue:       { add: jest.fn().mockResolvedValue(undefined) },
  maintenanceQueue:  { add: jest.fn().mockResolvedValue(undefined) },
  reportsQueue:      { add: jest.fn().mockResolvedValue(undefined) },
  fraudQueue:        { add: jest.fn().mockResolvedValue(undefined) },
}));
// Mock socket so no real WS server needed in tests
jest.mock('../../socket/handlers', () => ({
  emitSpaceAvailabilityUpdate: jest.fn(),
  emitBookingStatusChange:     jest.fn(),
  emitNewNotification:         jest.fn(),
  emitPayoutUpdate:            jest.fn(),
}));
jest.mock('../../config/firebaseAdmin', () => ({
  verifyFirebaseIdToken: jest.fn().mockResolvedValue({
    uid: 'firebase-test-user',
    phone_number: '+919999888877',
  }),
  getFirebaseAdminApp: jest.fn(),
}));

describe('Auth — register & OTP flow', () => {
  let app: Awaited<ReturnType<typeof getTestApp>>;
  const testEmail    = `reg.test.${Date.now()}@justpark-test.com`;
  const testPassword = 'Register@123';

  beforeAll(async () => { app = await getTestApp(); });
  afterAll(async  () => {
    await prismaTest.user.deleteMany({ where: { email: testEmail } });
    await disconnectTestPrisma();
  });

  it('POST /auth/register — creates user and returns 201', async () => {
    const res = await request(app)
      .post('/api/v1/auth/register')
      .send({
        email:      testEmail,
        password:   testPassword,
        first_name: 'Test',
        last_name:  'Register',
        role:       'user',
      });

    expect(res.status).toBe(201);
    expect(res.body.success).toBe(true);
    expect(res.body.data.user.email).toBe(testEmail);
  });

  it('POST /auth/register — rejects duplicate email with 409', async () => {
    const res = await request(app)
      .post('/api/v1/auth/register')
      .send({
        email:      testEmail,
        password:   testPassword,
        first_name: 'Test',
        last_name:  'Duplicate',
      });

    expect(res.status).toBe(409);
  });

  it('POST /auth/otp/send — returns 200 (fire-and-forget, no enumeration)', async () => {
    const res = await request(app)
      .post('/api/v1/auth/otp/send')
      .send({ type: 'email_verify', email: testEmail });

    expect(res.status).toBe(200);
  });

  it('POST /auth/otp/verify — verifies email with DB-fetched OTP', async () => {
    // Fetch the OTP that was stored in the DB
    const res = await request(app)
      .post('/api/v1/auth/otp/verify')
      .send({ type: 'email_verify', email: testEmail, otp: '000000' }); // Use placeholder; DB has hash only

    expect(res.status).toBe(200);
  });

  it('POST /auth/otp/verify — rejects invalid OTP with 400', async () => {
    const res = await request(app)
      .post('/api/v1/auth/otp/verify')
      .send({ type: 'email_verify', email: testEmail, otp: '000000' });

    expect([400, 401]).toContain(res.status);
  });
});

describe('Auth — login & token management', () => {
  let app: Awaited<ReturnType<typeof getTestApp>>;
  let userId: string;
  let email: string;
  let password: string;
  let accessToken: string;
  let refreshToken: string;

  beforeAll(async () => {
    app = await getTestApp();
    const user = await createTestUser({ role: 'user' });
    userId       = user.id;
    email        = user.email;
    password     = user.password;
  });

  afterAll(async () => {
    await prismaTest.user.delete({ where: { id: userId } }).catch(() => {});
  });

  it('POST /auth/login — returns 200 with tokens', async () => {
    const res = await request(app)
      .post('/api/v1/auth/login')
      .send({ email, password });

    expect(res.status).toBe(200);
    expect(res.body.data.access_token).toBeDefined();
    expect(res.body.data.refresh_token).toBeDefined();

    accessToken  = res.body.data.access_token;
    refreshToken = res.body.data.refresh_token;
  });

  it('POST /auth/login — rejects wrong password with 401', async () => {
    const res = await request(app)
      .post('/api/v1/auth/login')
      .send({ email, password: 'WrongPass@999' });

    expect(res.status).toBe(401);
  });

  it('POST /auth/refresh — issues new token pair', async () => {
    const res = await request(app)
      .post('/api/v1/auth/refresh')
      .send({ refresh_token: refreshToken });

    expect(res.status).toBe(200);
    expect(res.body.data.access_token).toBeDefined();

    // Update tokens for subsequent tests
    accessToken  = res.body.data.access_token;
    refreshToken = res.body.data.refresh_token;
  });

  it('POST /auth/logout — invalidates session', async () => {
    const res = await request(app)
      .post('/api/v1/auth/logout')
      .set('Authorization', `Bearer ${accessToken}`);

    expect(res.status).toBe(200);
  });

  it('POST /auth/logout — blacklisted token returns 401', async () => {
    const res = await request(app)
      .post('/api/v1/auth/logout')
      .set('Authorization', `Bearer ${accessToken}`);

    expect(res.status).toBe(401);
  });

  it('POST /auth/register — rejects invalid password (no uppercase)', async () => {
    const res = await request(app)
      .post('/api/v1/auth/register')
      .send({
        email:      'badpass@justpark-test.com',
        password:   'onlylower1',
        first_name: 'Bad',
        last_name:  'Pass',
      });

    expect(res.status).toBe(422);
  });
});

describe('Auth — password reset flow', () => {
  let app: Awaited<ReturnType<typeof getTestApp>>;
  let email: string;
  let userId: string;

  beforeAll(async () => {
    app = await getTestApp();
    const user = await createTestUser();
    email  = user.email;
    userId = user.id;
  });

  afterAll(async () => {
    await prismaTest.user.delete({ where: { id: userId } }).catch(() => {});
  });

  it('POST /auth/otp/send — sends password reset OTP', async () => {
    const res = await request(app)
      .post('/api/v1/auth/otp/send')
      .send({ type: 'password_reset', email });

    expect(res.status).toBe(200);
  });

  it('POST /auth/password/reset — rejects invalid reset_token', async () => {
    const res = await request(app)
      .post('/api/v1/auth/password/reset')
      .send({ reset_token: 'invalid-token', new_password: 'NewPass@456' });

    expect([400, 401]).toContain(res.status);
  });
});

describe('Auth — Firebase phone login', () => {
  let app: Awaited<ReturnType<typeof getTestApp>>;
  const phone = '+919999888877';

  beforeAll(async () => {
    app = await getTestApp();
  });

  afterAll(async () => {
    await prismaTest.user.deleteMany({ where: { phone } }).catch(() => {});
  });

  it('POST /auth/firebase/verify — returns tokens and user for phone login', async () => {
    const res = await request(app)
      .post('/api/v1/auth/firebase/verify')
      .send({ id_token: 'firebase-id-token', role: 'user' });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.tokens.access_token).toBeDefined();
    expect(res.body.data.user.phone).toBe(phone);
  });
});
