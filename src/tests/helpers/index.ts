/**
 * Test helpers — shared utilities for integration tests.
 *
 * Usage:
 *   import { getTestApp, createTestUser, loginTestUser, cleanupTestUser } from '../helpers';
 */
import request from 'supertest';
import bcrypt from 'bcrypt';
import { PrismaClient } from '@prisma/client';
import type { Application } from 'express';

// ─────────────────────────────────────────────
// Lazy-initialised app (avoids repeated server boots)
// ─────────────────────────────────────────────
let _app: Application | null = null;

export async function getTestApp(): Promise<Application> {
  if (_app) return _app;

  // Import AFTER env.setup.ts has loaded .env.test
  const { createApp } = await import('../../app');
  _app = createApp();
  return _app;
}

// ─────────────────────────────────────────────
// Prisma test client
// ─────────────────────────────────────────────
export const prismaTest = new PrismaClient({
  datasources: { db: { url: process.env['DATABASE_URL'] } },
});

// ─────────────────────────────────────────────
// User helpers
// ─────────────────────────────────────────────
export interface TestUserCredentials {
  id: string;
  email: string;
  password: string;
  role: 'user' | 'host' | 'admin';
}

export interface TestAuthTokens {
  access_token: string;
  refresh_token: string;
}

let _userCounter = 0;

/**
 * Creates a user directly in DB (bypasses OTP) and returns credentials.
 * The user has email_verified=true so login works immediately.
 */
export async function createTestUser(
  overrides: Partial<{
    role: 'user' | 'host' | 'admin';
    email: string;
    password: string;
  }> = {}
): Promise<TestUserCredentials> {
  const suffix = ++_userCounter + Date.now();
  const password = overrides.password ?? 'TestUser@123';
  const email    = overrides.email    ?? `test.user.${suffix}@justpark-test.com`;
  const role     = overrides.role     ?? 'user';

  const password_hash = await bcrypt.hash(password, 4); // Low rounds for speed in tests

  const user = await prismaTest.user.create({
    data: {
      email,
      phone: `+9199${String(suffix).slice(-8).padStart(8, '0')}`,
      password_hash,
      first_name: 'Test',
      last_name: 'User',
      role,
      email_verified: true,
      phone_verified: true,
      status: 'active',
    },
  });

  // Create wallet for the user
  await prismaTest.wallet.upsert({
    where: { user_id: user.id },
    update: {},
    create: { user_id: user.id, balance: 1000, currency: 'INR' },
  });

  return { id: user.id, email, password, role };
}

/**
 * Logs in a test user via the API and returns tokens.
 */
export async function loginTestUser(
  app: Application,
  credentials: Pick<TestUserCredentials, 'email' | 'password'>
): Promise<TestAuthTokens> {
  const res = await request(app as Parameters<typeof request>[0])
    .post('/api/v1/auth/login')
    .send({ email: credentials.email, password: credentials.password });

  if (res.status !== 200) {
    throw new Error(`Login failed for ${credentials.email}: ${JSON.stringify(res.body)}`);
  }

  return {
    access_token:  res.body.data.access_token,
    refresh_token: res.body.data.refresh_token,
  };
}

/**
 * Removes a test user from the DB (cascade deletes related records).
 */
export async function cleanupTestUser(userId: string): Promise<void> {
  await prismaTest.user.delete({ where: { id: userId } }).catch(() => {});
}

// ─────────────────────────────────────────────
// Space helper
// ─────────────────────────────────────────────
export async function createTestSpace(hostId: string): Promise<{ id: string; name: string }> {
  const space = await prismaTest.parkingSpace.create({
    data: {
      host_id: hostId,
      name: `Test Space ${Date.now()}`,
      description: 'Test parking space for integration tests.',
      address_line1: '123 Test Street',
      city: 'Mumbai',
      state: 'Maharashtra',
      postal_code: '400001',
      country: 'IN',
      geohash: 'te7u00',
      space_type: 'open_air',
      total_capacity: 5,
      allowed_vehicles: ['car'],
      status: 'active',
      cancellation_policy: 'flexible',
      min_booking_duration_minutes: 60,
      instant_book: true,
    },
  });

  // Add a pricing rule
  await prismaTest.spacePricingRule.create({
    data: {
      space_id: space.id,
      rate_type: 'hourly',
      base_rate: 50,
      currency: 'INR',
      min_price: 50,
    },
  });

  return { id: space.id, name: space.name };
}

// ─────────────────────────────────────────────
// Disconnect helper — call in afterAll
// ─────────────────────────────────────────────
export async function disconnectTestPrisma(): Promise<void> {
  await prismaTest.$disconnect();
}
