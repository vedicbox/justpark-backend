import express, { Application, Request, Response, NextFunction } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import compression from 'compression';
import cookieParser from 'cookie-parser';
import swaggerJsdoc from 'swagger-jsdoc';
import swaggerUi from 'swagger-ui-express';
import { createBullBoard } from '@bull-board/api';
import { BullMQAdapter } from '@bull-board/api/bullMQAdapter';
import { ExpressAdapter } from '@bull-board/express';
import { env, isDev, isProd, isTest } from './config/env';
import { requestLogger } from './middleware/requestLogger';
import { apiRateLimiter } from './middleware/rateLimiter';
import { errorHandler, notFoundHandler } from './middleware/errorHandler';
import { authenticate } from './middleware/auth';
import { requireRole } from './middleware/roleGuard';
import { checkDatabaseHealth } from './config/database';
import { checkRedisHealth, redis } from './config/redis';
import { HealthCheckResult } from './types';
import {
  notificationQueue,
  bookingQueue,
  payoutQueue,
  maintenanceQueue,
  reportsQueue,
  fraudQueue,
} from './jobs';

// ─────────────────────────────────────────────
// Module routers (stubs — populated in Phase 2+)
// ─────────────────────────────────────────────
import { authRouter } from './modules/auth/routes';
import { usersRouter } from './modules/users/routes';
import { spacesRouter } from './modules/spaces/routes';
import { bookingsRouter } from './modules/bookings/routes';
import { paymentsRouter } from './modules/payments/routes';
import { walletRouter } from './modules/wallet/routes';
import { notificationsRouter } from './modules/notifications/routes';
import { reviewsRouter } from './modules/reviews/routes';
import { favoritesRouter } from './modules/favorites/routes';
import { supportRouter } from './modules/support/routes';
import { hostRouter } from './modules/host/routes';
import { adminRouter } from './modules/admin/routes';
import { parkingSpacesRouter } from './modules/parking-spaces/routes';

// ─────────────────────────────────────────────
// App factory
// ─────────────────────────────────────────────
export function createApp(): Application {
  const app = express();

  // ── 1. Trust proxy (required when behind nginx/load balancer for correct IP)
  app.set('trust proxy', 1);

  // ── 1b. HTTPS enforcement — production only
  // Must come after 'trust proxy' so req.protocol reads x-forwarded-proto correctly.
  // Load balancers (nginx, ALB) terminate TLS and forward plain HTTP internally;
  // they set x-forwarded-proto: https on the original HTTPS request.
  if (isProd) {
    app.use((req: Request, res: Response, next: NextFunction) => {
      if (req.protocol !== 'https') {
        return res.redirect(301, `https://${req.hostname}${req.originalUrl}`);
      }
      next();
    });
  }

  // ── 2. CORS
  const allowedOrigins = env.FRONTEND_ORIGINS.split(',').map((o) => o.trim());
  // In development we allow a small fallback set in addition to FRONTEND_ORIGINS
  // because Vite defaults to :5173 and some local setups run the frontend on :3002.
  const devFallbackOrigins = ['http://localhost:5173', 'http://localhost:3002'];
  app.use(
    cors({
      origin: (origin, callback) => {
        // Allow requests with no origin (curl, mobile apps, Postman)
        if (!origin) return callback(null, true);
        if (allowedOrigins.includes(origin)) return callback(null, true);
        if (isDev && devFallbackOrigins.includes(origin)) {
          console.warn(`⚠️  CORS: allowing development fallback origin ${origin}`);
          return callback(null, true);
        }
        callback(new Error(`CORS: origin ${origin} not allowed`));
      },
      credentials: true,
      methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
      allowedHeaders: [
        'Content-Type',
        'Authorization',
        'X-Request-ID',
        'X-Idempotency-Key',
        'X-Client-Version',
      ],
      exposedHeaders: [
          'X-Request-ID',
          // Legacy X- headers (set by legacyHeaders: true) — widely supported by client libraries
          'X-RateLimit-Limit',
          'X-RateLimit-Remaining',
          'X-RateLimit-Reset',
          // IETF draft-6 standard headers (set by standardHeaders: true)
          'RateLimit-Limit',
          'RateLimit-Remaining',
          'RateLimit-Reset',
          'RateLimit-Policy',
        ],
      maxAge: 86400, // Preflight cache: 24 hours
    })
  );

  // ── 3. Helmet — security headers
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'"],
          styleSrc: ["'self'"],
          imgSrc: ["'self'", 'data:', 'https:'],
          connectSrc: ["'self'"],
          fontSrc: ["'self'"],
          objectSrc: ["'none'"],
          mediaSrc: ["'self'"],
          frameSrc: ["'none'"],
        },
      },
      crossOriginEmbedderPolicy: false,
      hsts: {
        maxAge: 31_536_000,
        includeSubDomains: true,
        preload: true,
      },
    })
  );

  // ── 4. Compression
  app.use(compression());

  // ─────────────────────────────────────────────
  // CSRF — why this API is safe without a CSRF token
  // ─────────────────────────────────────────────
  // Every state-changing endpoint requires an Authorization: Bearer <token> header.
  // A cross-origin form submission or img/script tag cannot set custom request headers,
  // so a browser-initiated CSRF attack cannot satisfy that requirement. The Same-Origin
  // Policy is the enforcement point; no CSRF token is needed while access-token auth
  // lives in the Authorization header.
  //
  // Concrete guarantees in this codebase:
  //   • authenticate() middleware rejects any request without a valid Bearer token.
  //   • Access tokens are stored in JS memory only — never in cookies or localStorage —
  //     so the browser never attaches them automatically on cross-origin requests.
  //   • CORS is locked to FRONTEND_ORIGINS (env var); cross-origin pre-flighted
  //     requests from unexpected origins are rejected before they reach any handler.
  //
  // The refresh token IS stored as an HttpOnly SameSite=Strict cookie (jp_refresh).
  // This cookie is only sent to /api/v1/auth paths. The two endpoints that accept it
  // (/auth/refresh and /auth/logout) do not perform state-changing business logic
  // without a valid access token, and SameSite=Strict ensures the cookie is never
  // sent on cross-site navigations. No additional CSRF token is needed for these
  // endpoints because:
  //   • SameSite=Strict blocks the cookie on all cross-site requests (including
  //     cross-origin fetches, form submissions, and top-level navigations from a
  //     different site).
  //   • /auth/refresh only issues new tokens and sets a new cookie — it does not
  //     mutate application data.
  //   • /auth/logout is protected by authenticate() (requires Bearer token).
  //
  // ⚠️  If you ever set SameSite=Lax or SameSite=None on a cookie that gates a
  //   state-changing endpoint, add a CSRF token layer for defence-in-depth:
  //        import csrf from 'csurf';
  //        app.use(csrf({ cookie: { httpOnly: true, sameSite: 'strict', secure: true } }));
  //        // Expose token to the frontend via a GET endpoint or a response header.
  //        // Reject requests where req.csrfToken() !== X-CSRF-Token header value.
  // ─────────────────────────────────────────────

  // ── 4b. BullMQ dashboard — /admin/queues (SECURED)
  // Mounted before the main security middleware so the board can serve its own assets.
  // Override CSP for this path only to allow bull-board's inline scripts/styles.
  // SECURED: Requires authentication + admin role
  if (!isTest) {
    const serverAdapter = new ExpressAdapter();
    serverAdapter.setBasePath('/admin/queues');
    createBullBoard({
      queues: [
        new BullMQAdapter(notificationQueue),
        new BullMQAdapter(bookingQueue),
        new BullMQAdapter(payoutQueue),
        new BullMQAdapter(maintenanceQueue),
        new BullMQAdapter(reportsQueue),
        new BullMQAdapter(fraudQueue),
      ],
      serverAdapter,
    });
    app.use(
      '/admin/queues',
      // Security middleware: authenticate + require admin role
      authenticate,
      requireRole('admin'),
      (_req: Request, res: Response, next) => {
        // Relax CSP for the queue dashboard only (maintains security for other routes)
        res.setHeader(
          'Content-Security-Policy',
          "default-src 'self' 'unsafe-inline' 'unsafe-eval'; img-src 'self' data: https:; connect-src 'self';"
        );
        next();
      },
      serverAdapter.getRouter()
    );
  }

  // ── 5. JSON body parser (5MB limit — covers base64-encoded images in edge cases)
  // The verify callback captures the raw body buffer for webhook signature
  // verification (Stripe / Razorpay) without a separate raw-body middleware.
  app.use(
    express.json({
      limit: '5mb',
      strict: true,
      verify: (req: Request, _res, buf: Buffer) => {
        req.rawBody = buf;
      },
    })
  );

  // URL-encoded form data (for Stripe/Razorpay webhook compatibility)
  app.use(
    express.urlencoded({
      extended: true,
      limit: '1mb',
    })
  );

  // ── Cookie parser (required for HttpOnly refresh-token cookie on /auth/refresh)
  app.use(cookieParser());

  // ── 6. Request logger (structured JSON via pino-http)
  app.use(requestLogger);

  // ── 7. Global API rate limiter (Redis-backed)
  app.use(`/api/${env.API_VERSION}`, apiRateLimiter);

  // ─────────────────────────────────────────────
  // Swagger / OpenAPI — /api/docs
  // ─────────────────────────────────────────────
  const swaggerSpec = swaggerJsdoc({
    definition: {
      openapi: '3.0.0',
      info: {
        title:       'JustPark API',
        version:     '1.0.0',
        description: 'Parking marketplace API — book, list, and manage parking spaces across India.',
      },
      servers: [{ url: `/api/${env.API_VERSION}`, description: 'Current environment' }],
      components: {
        securitySchemes: {
          bearerAuth: {
            type:         'http',
            scheme:       'bearer',
            bearerFormat: 'JWT',
          },
        },
        schemas: {
          ApiSuccess: {
            type: 'object',
            properties: {
              success: { type: 'boolean', example: true },
              data:    { type: 'object' },
              message: { type: 'string' },
            },
          },
          ApiError: {
            type: 'object',
            properties: {
              success: { type: 'boolean', example: false },
              error: {
                type: 'object',
                properties: {
                  code:    { type: 'string' },
                  message: { type: 'string' },
                },
              },
            },
          },
          RegisterRequest: {
            type: 'object',
            required: ['email', 'password', 'first_name', 'last_name'],
            properties: {
              email:      { type: 'string', format: 'email' },
              password:   { type: 'string', minLength: 8 },
              first_name: { type: 'string' },
              last_name:  { type: 'string' },
              phone:      { type: 'string', example: '+919876543210' },
              role:       { type: 'string', enum: ['user', 'host'], default: 'user' },
            },
          },
          LoginRequest: {
            type: 'object',
            required: ['email', 'password'],
            properties: {
              email:    { type: 'string', format: 'email' },
              password: { type: 'string' },
            },
          },
          AuthTokens: {
            type: 'object',
            properties: {
              access_token:  { type: 'string' },
              refresh_token: { type: 'string' },
              expires_in:    { type: 'number' },
            },
          },
          BookingCreate: {
            type: 'object',
            required: ['space_id', 'lock_id', 'start_time', 'end_time', 'vehicle_id'],
            properties: {
              space_id:       { type: 'string', format: 'uuid' },
              lock_id:        { type: 'string' },
              start_time:     { type: 'string', format: 'date-time' },
              end_time:       { type: 'string', format: 'date-time' },
              vehicle_id:     { type: 'string', format: 'uuid' },
              payment_method: { type: 'string', enum: ['card', 'upi', 'wallet'] },
              promo_code:     { type: 'string' },
            },
          },
          HealthCheck: {
            type: 'object',
            properties: {
              status:    { type: 'string', enum: ['ok', 'degraded', 'down'] },
              timestamp: { type: 'string', format: 'date-time' },
              uptime:    { type: 'number' },
              version:   { type: 'string' },
              services: {
                type: 'object',
                properties: {
                  database: { type: 'object', properties: { status: { type: 'string' }, latency_ms: { type: 'number' } } },
                  redis:    { type: 'object', properties: { status: { type: 'string' } } },
                },
              },
            },
          },
        },
      },
      paths: {
        '/auth/register': {
          post: {
            tags:        ['Auth'],
            summary:     'Register a new user or host account',
            requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/RegisterRequest' } } } },
            responses: {
              201: { description: 'User created', content: { 'application/json': { schema: { $ref: '#/components/schemas/ApiSuccess' } } } },
              409: { description: 'Email already registered' },
              422: { description: 'Validation error' },
            },
          },
        },
        '/auth/login': {
          post: {
            tags:        ['Auth'],
            summary:     'Login with email + password',
            requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/LoginRequest' } } } },
            responses: {
              200: { description: 'Tokens returned', content: { 'application/json': { schema: { $ref: '#/components/schemas/AuthTokens' } } } },
              401: { description: 'Invalid credentials' },
            },
          },
        },
        '/auth/admin/login': {
          post: {
            tags: ['Auth'],
            summary: 'Admin login with email + password',
            requestBody: {
              required: true,
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    required: ['email', 'password'],
                    properties: {
                      email: { type: 'string', format: 'email' },
                      password: { type: 'string' },
                    },
                  },
                },
              },
            },
            responses: {
              200: { description: 'Admin tokens returned', content: { 'application/json': { schema: { $ref: '#/components/schemas/AuthTokens' } } } },
              401: { description: 'Invalid credentials' },
              403: { description: 'Not authorized as admin' },
            },
          },
        },
        '/auth/refresh': {
          post: {
            tags:    ['Auth'],
            summary: 'Rotate refresh token',
            requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', properties: { refresh_token: { type: 'string' } } } } } },
            responses: { 200: { description: 'New token pair' }, 401: { description: 'Invalid refresh token' } },
          },
        },
        '/auth/logout': {
          post: {
            tags:     ['Auth'],
            summary:  'Logout and invalidate session',
            security: [{ bearerAuth: [] }],
            responses: { 200: { description: 'Logged out' }, 401: { description: 'Unauthorized' } },
          },
        },
        '/auth/otp/send': {
          post: {
            tags:    ['Auth'],
            summary: 'Send OTP for email verification or password reset',
            description: 'Phone verification moved to Firebase Auth and is no longer supported by this endpoint.',
            requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['type', 'email'], properties: { type: { type: 'string', enum: ['email_verify', 'password_reset'] }, email: { type: 'string' } } } } } },
            responses: { 200: { description: 'OTP sent (always 200 to prevent enumeration)' } },
          },
        },
        '/auth/otp/verify': {
          post: {
            tags:    ['Auth'],
            summary: 'Verify OTP for email verification or password reset',
            description: 'Phone verification moved to Firebase Auth and is no longer supported by this endpoint.',
            requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['type', 'otp', 'email'], properties: { type: { type: 'string', enum: ['email_verify', 'password_reset'] }, otp: { type: 'string', minLength: 6, maxLength: 6 }, email: { type: 'string' } } } } } },
            responses: { 200: { description: 'OTP verified' }, 400: { description: 'Invalid or expired OTP' } },
          },
        },
        '/auth/firebase/verify': {
          post: {
            tags: ['Auth'],
            summary: 'Verify Firebase phone authentication token',
            description: 'Exchange a Firebase Phone Auth ID token for JustPark access and refresh tokens. This endpoint is the supported phone authentication flow; legacy phone OTP endpoints are deprecated for phone auth.',
            requestBody: {
              required: true,
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    required: ['idToken'],
                    properties: {
                      idToken: { type: 'string', description: 'Firebase ID token issued after phone OTP verification on the frontend' },
                    },
                  },
                },
              },
            },
            responses: {
              200: {
                description: 'Firebase token verified and JustPark session created',
                content: {
                  'application/json': {
                    schema: {
                      type: 'object',
                      properties: {
                        success: { type: 'boolean', example: true },
                        data: {
                          type: 'object',
                          properties: {
                            token: { type: 'string' },
                            refreshToken: { type: 'string' },
                            user: { type: 'object' },
                          },
                        },
                      },
                    },
                  },
                },
              },
              401: { description: 'Invalid or expired Firebase token' },
              404: { description: 'User not found (needs registration first)' },
            },
          },
        },
        '/spaces/search': {
          get: {
            tags:    ['Spaces'],
            summary: 'Search for parking spaces near a location',
            parameters: [
              { name: 'lat',    in: 'query', required: true,  schema: { type: 'number' } },
              { name: 'lng',    in: 'query', required: true,  schema: { type: 'number' } },
              { name: 'radius', in: 'query', required: false, schema: { type: 'number', default: 2000 } },
              { name: 'available_from', in: 'query', schema: { type: 'string', format: 'date-time' } },
              { name: 'available_to',   in: 'query', schema: { type: 'string', format: 'date-time' } },
              { name: 'vehicle_type',   in: 'query', schema: { type: 'string', enum: ['car', 'bike', 'ev', 'truck', 'van'] } },
              { name: 'min_price', in: 'query', schema: { type: 'number' } },
              { name: 'max_price', in: 'query', schema: { type: 'number' } },
              { name: 'sort',      in: 'query', schema: { type: 'string', enum: ['distance', 'price_asc', 'price_desc', 'rating'] } },
              { name: 'page',  in: 'query', schema: { type: 'integer', default: 1 } },
              { name: 'limit', in: 'query', schema: { type: 'integer', default: 20 } },
            ],
            responses: { 200: { description: 'List of spaces' }, 422: { description: 'Missing lat/lng' } },
          },
        },
        '/spaces/{id}': {
          get: {
            tags:    ['Spaces'],
            summary: 'Get a space by ID',
            parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
            responses: { 200: { description: 'Space detail' }, 404: { description: 'Not found' } },
          },
        },
        '/spaces/{id}/availability': {
          get: {
            tags:    ['Spaces'],
            summary: 'Check availability for a time window',
            parameters: [
              { name: 'id',         in: 'path',  required: true, schema: { type: 'string', format: 'uuid' } },
              { name: 'start_time', in: 'query', required: true, schema: { type: 'string', format: 'date-time' } },
              { name: 'end_time',   in: 'query', required: true, schema: { type: 'string', format: 'date-time' } },
            ],
            responses: { 200: { description: 'Availability result' }, 422: { description: 'Missing time params' } },
          },
        },
        '/bookings/lock': {
          post: {
            tags:     ['Bookings'],
            summary:  'Lock a slot for 10 minutes before creating a booking',
            security: [{ bearerAuth: [] }],
            requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['space_id', 'start_time', 'end_time'], properties: { space_id: { type: 'string', format: 'uuid' }, start_time: { type: 'string', format: 'date-time' }, end_time: { type: 'string', format: 'date-time' } } } } } },
            responses: { 200: { description: 'Lock acquired' }, 409: { description: 'Slot already locked' }, 401: { description: 'Unauthorized' } },
          },
        },
        '/bookings': {
          get: {
            tags:     ['Bookings'],
            summary:  'List user bookings',
            security: [{ bearerAuth: [] }],
            parameters: [
              { name: 'status', in: 'query', schema: { type: 'string' } },
              { name: 'page',   in: 'query', schema: { type: 'integer' } },
              { name: 'limit',  in: 'query', schema: { type: 'integer' } },
            ],
            responses: { 200: { description: 'Bookings list' }, 401: { description: 'Unauthorized' } },
          },
          post: {
            tags:     ['Bookings'],
            summary:  'Create a booking',
            security: [{ bearerAuth: [] }],
            requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/BookingCreate' } } } },
            responses: { 201: { description: 'Booking created' }, 400: { description: 'Invalid lock or payment required' }, 401: { description: 'Unauthorized' } },
          },
        },
        '/bookings/{id}': {
          get: {
            tags:     ['Bookings'],
            summary:  'Get booking details',
            security: [{ bearerAuth: [] }],
            parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
            responses: { 200: { description: 'Booking detail' }, 404: { description: 'Not found' } },
          },
        },
        '/bookings/{id}/cancel': {
          post: {
            tags:     ['Bookings'],
            summary:  'Cancel a booking',
            security: [{ bearerAuth: [] }],
            parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
            requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { reason: { type: 'string' } } } } } },
            responses: { 200: { description: 'Cancelled' }, 400: { description: 'Cannot cancel' } },
          },
        },
        '/payments/intent': {
          post: {
            tags:     ['Payments'],
            summary:  'Create a payment intent',
            security: [{ bearerAuth: [] }],
            requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['booking_id', 'gateway'], properties: { booking_id: { type: 'string', format: 'uuid' }, gateway: { type: 'string', enum: ['stripe', 'razorpay'] } } } } } },
            responses: { 200: { description: 'Payment intent created' } },
          },
        },
        '/wallet/balance': {
          get: {
            tags:     ['Wallet'],
            summary:  'Get wallet balance',
            security: [{ bearerAuth: [] }],
            responses: { 200: { description: 'Wallet details' } },
          },
        },
        '/wallet/topup': {
          post: {
            tags:     ['Wallet'],
            summary:  'Top up wallet',
            security: [{ bearerAuth: [] }],
            requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['amount'], properties: { amount: { type: 'number', minimum: 10 } } } } } },
            responses: { 200: { description: 'Top-up initiated' } },
          },
        },
        '/notifications': {
          get: {
            tags:     ['Notifications'],
            summary:  'List notifications',
            security: [{ bearerAuth: [] }],
            responses: { 200: { description: 'Notification list' } },
          },
        },
        '/reviews': {
          post: {
            tags:     ['Reviews'],
            summary:  'Submit a review for a booking',
            security: [{ bearerAuth: [] }],
            requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['booking_id', 'rating'], properties: { booking_id: { type: 'string', format: 'uuid' }, rating: { type: 'integer', minimum: 1, maximum: 5 }, comment: { type: 'string' } } } } } },
            responses: { 201: { description: 'Review created' } },
          },
        },
        '/host/spaces': {
          get: {
            tags:     ['Host'],
            summary:  'List host spaces',
            security: [{ bearerAuth: [] }],
            responses: { 200: { description: 'Host spaces' } },
          },
          post: {
            tags:     ['Host'],
            summary:  'Create a new parking space listing',
            security: [{ bearerAuth: [] }],
            responses: { 201: { description: 'Space created as draft' } },
          },
        },
        '/host/earnings': {
          get: {
            tags:     ['Host'],
            summary:  'Get host earnings summary',
            security: [{ bearerAuth: [] }],
            responses: { 200: { description: 'Earnings' } },
          },
        },
        '/host/payouts': {
          post: {
            tags:     ['Host'],
            summary:  'Request a payout',
            security: [{ bearerAuth: [] }],
            responses: { 201: { description: 'Payout requested' } },
          },
        },
        '/admin/spaces/pending': {
          get: {
            tags:     ['Admin'],
            summary:  'List spaces pending review',
            security: [{ bearerAuth: [] }],
            responses: { 200: { description: 'Pending spaces' }, 403: { description: 'Admin only' } },
          },
        },
      },
    },
    apis: [], // All docs defined inline above
  });

  app.use(
    '/api/docs',
    (_req: Request, res: Response, next: NextFunction) => {
      // Relax CSP for Swagger UI
      res.setHeader(
        'Content-Security-Policy',
        "default-src 'self' 'unsafe-inline' 'unsafe-eval'; img-src 'self' data: https:; connect-src 'self';"
      );
      next();
    },
    swaggerUi.serve,
    swaggerUi.setup(swaggerSpec, {
      customSiteTitle: 'JustPark API Docs',
      swaggerOptions: { persistAuthorization: true },
    })
  );

  // Expose raw spec as JSON
  app.get('/api/docs.json', (_req: Request, res: Response) => res.json(swaggerSpec));

  // ─────────────────────────────────────────────
  // Health Check — before auth middleware
  // ─────────────────────────────────────────────
  app.get('/health', async (_req: Request, res: Response) => {
    const start = Date.now();

    const [dbHealthy, redisHealthy] = await Promise.allSettled([
      checkDatabaseHealth(),
      checkRedisHealth(),
    ]);

    const dbOk = dbHealthy.status === 'fulfilled' && dbHealthy.value === true;
    const redisOk = redisHealthy.status === 'fulfilled' && redisHealthy.value === true;

    const allOk = dbOk && redisOk;

    const result: HealthCheckResult = {
      status: allOk ? 'ok' : !dbOk && !redisOk ? 'down' : 'degraded',
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      version: process.env.npm_package_version ?? '1.0.0',
      services: {
        database: {
          status: dbOk ? 'ok' : 'down',
          latency_ms: Date.now() - start,
          ...(!dbOk && {
            error:
              dbHealthy.status === 'rejected'
                ? String(dbHealthy.reason)
                : 'Database unreachable',
          }),
        },
        redis: {
          status: redisOk ? 'ok' : 'down',
          ...(!redisOk && {
            error:
              redisHealthy.status === 'rejected'
                ? String(redisHealthy.reason)
                : 'Redis unreachable',
          }),
        },
      },
    };

    res.status(allOk ? 200 : 503).json(result);
  });

  // ─────────────────────────────────────────────
  // Health Detailed — admin only
  // ─────────────────────────────────────────────
  app.get(
    '/health/detailed',
    authenticate,
    requireRole('admin'),
    async (_req: Request, res: Response) => {
      const start = Date.now();

      const [dbHealthy, redisHealthy] = await Promise.allSettled([
        checkDatabaseHealth(),
        checkRedisHealth(),
      ]);

      const dbOk    = dbHealthy.status    === 'fulfilled' && dbHealthy.value    === true;
      const redisOk = redisHealthy.status === 'fulfilled' && redisHealthy.value === true;
      const allOk   = dbOk && redisOk;

      // Queue lengths from Redis
      let queues: Record<string, number> = {};
      try {
        const queueNames = ['notification', 'booking', 'payout', 'maintenance', 'reports', 'fraud'];
        const results = await Promise.all(
          queueNames.map((q) => redis.llen(`bull:${q}:wait`).catch(() => 0))
        );
        queues = Object.fromEntries(queueNames.map((q, i) => [q, results[i]]));
      } catch {
        // non-fatal
      }

      res.status(allOk ? 200 : 503).json({
        status:    allOk ? 'ok' : !dbOk && !redisOk ? 'down' : 'degraded',
        timestamp: new Date().toISOString(),
        uptime:    process.uptime(),
        version:   process.env['npm_package_version'] ?? '1.0.0',
        memory:    process.memoryUsage(),
        services: {
          database: {
            status:     dbOk ? 'ok' : 'down',
            latency_ms: Date.now() - start,
            ...(!dbOk && {
              error: dbHealthy.status === 'rejected' ? String(dbHealthy.reason) : 'Database unreachable',
            }),
          },
          redis: {
            status: redisOk ? 'ok' : 'down',
            ...(!redisOk && {
              error: redisHealthy.status === 'rejected' ? String(redisHealthy.reason) : 'Redis unreachable',
            }),
          },
        },
        queues,
      });
    }
  );

  // ─────────────────────────────────────────────
  // API Routes — /api/v1/*
  // ─────────────────────────────────────────────
  const apiBase = `/api/${env.API_VERSION}`;

  app.use(`${apiBase}/auth`,          authRouter);
  app.use(`${apiBase}/users`,         usersRouter);
  app.use(`${apiBase}/spaces`,        spacesRouter);
  app.use(`${apiBase}/bookings`,      bookingsRouter);
  app.use(`${apiBase}/payments`,      paymentsRouter);
  app.use(`${apiBase}/wallet`,        walletRouter);
  app.use(`${apiBase}/notifications`, notificationsRouter);
  app.use(`${apiBase}/reviews`,       reviewsRouter);
  app.use(`${apiBase}/favorites`,     favoritesRouter);
  app.use(`${apiBase}/support`,       supportRouter);
  app.use(`${apiBase}/host`,          hostRouter);
  app.use(`${apiBase}/admin`,         adminRouter);
  app.use(`${apiBase}/parking-spaces`, parkingSpacesRouter);

  // ─────────────────────────────────────────────
  // 404 handler — must be AFTER all routes
  // ─────────────────────────────────────────────
  app.use(notFoundHandler);

  // ─────────────────────────────────────────────
  // Centralized error handler — must be LAST
  // ─────────────────────────────────────────────
  app.use(errorHandler);

  return app;
}
