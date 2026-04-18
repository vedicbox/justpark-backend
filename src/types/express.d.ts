// Augments the global Express Request type so `req.user` is always
// available on protected routes without casting to AuthenticatedRequest.
//
// This declaration merges into the existing @types/express namespace.

import { JwtPayload } from './index';

declare global {
  namespace Express {
    interface Request {
      /**
       * Set by `auth` middleware after successful JWT verification.
       * Undefined on public (unauthenticated) routes.
       */
      user?: JwtPayload;

      /**
       * Unique request ID injected by pino-http for tracing.
       */
      id?: string;

      /**
       * Raw request body buffer captured by the express.json() verify callback.
       * Used for webhook signature verification (Stripe / Razorpay).
       */
      rawBody?: Buffer;
    }
  }
}
