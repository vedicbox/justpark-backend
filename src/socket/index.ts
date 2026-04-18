import { Server as SocketIOServer } from 'socket.io';
import type { Server as HttpServer } from 'http';
import jwt from 'jsonwebtoken';
import { env } from '../config/env';
import { redis, RedisKeys } from '../config/redis';
import { logger } from '../utils/logger';
import type { JwtPayload } from '../types';

// ─────────────────────────────────────────────
// Module-level Socket.IO instance (singleton)
// ─────────────────────────────────────────────
let io: SocketIOServer | null = null;

// ─────────────────────────────────────────────
// initSocket — call once in server.ts with the HTTP server
// ─────────────────────────────────────────────
export function initSocket(httpServer: HttpServer): SocketIOServer {
  const allowedOrigins = env.FRONTEND_ORIGINS.split(',').map((o) => o.trim());

  io = new SocketIOServer(httpServer, {
    cors: {
      origin: allowedOrigins,
      credentials: true,
    },
    pingTimeout: 30_000,
    pingInterval: 25_000,
  });

  // ── JWT authentication middleware ────────────────────────────────────────
  io.use(async (socket, next) => {
    try {
      // Accept token from handshake.auth.token or Authorization header
      const rawToken =
        (socket.handshake.auth as Record<string, string> | undefined)?.token ??
        socket.handshake.headers?.authorization?.replace(/^Bearer\s+/i, '');

      if (!rawToken) {
        return next(new Error('Authentication token required'));
      }

      const payload = jwt.verify(rawToken, env.JWT_ACCESS_SECRET) as JwtPayload;

      // Check token blacklist (logged-out tokens)
      if (payload.jti) {
        const blacklisted = await redis.exists(RedisKeys.tokenBlacklist(payload.jti));
        if (blacklisted) {
          return next(new Error('Token has been revoked'));
        }
      }

      socket.data.user = payload;
      next();
    } catch {
      next(new Error('Invalid or expired token'));
    }
  });

  // ── Connection handler ───────────────────────────────────────────────────
  io.on('connection', (socket) => {
    const user    = socket.data.user as JwtPayload;
    const userId  = user.sub;

    // Auto-join personal room
    socket.join(`user:${userId}`);

    // Auto-join host room for host/admin users
    if (user.role === 'host' || user.role === 'admin') {
      socket.join(`host:${userId}`);
    }

    // Track online status (Redis set of socket IDs per user)
    redis.sadd(RedisKeys.userSocket(userId), socket.id).catch(() => {});

    logger.debug({ msg: 'socket:connected', userId, socketId: socket.id, role: user.role });

    // ── Room management events ───────────────────────────────────────────
    socket.on('join-space', (spaceId: unknown) => {
      if (typeof spaceId === 'string' && spaceId.trim()) {
        socket.join(`space:${spaceId.trim()}`);
      }
    });

    socket.on('leave-space', (spaceId: unknown) => {
      if (typeof spaceId === 'string' && spaceId.trim()) {
        socket.leave(`space:${spaceId.trim()}`);
      }
    });

    // ── Disconnect ───────────────────────────────────────────────────────
    socket.on('disconnect', () => {
      redis.srem(RedisKeys.userSocket(userId), socket.id).catch(() => {});
      logger.debug({ msg: 'socket:disconnected', userId, socketId: socket.id });
    });
  });

  logger.info('✅  Socket.IO initialized');
  return io;
}

// ─────────────────────────────────────────────
// getIO — returns the active instance (throws if not yet initialized)
// ─────────────────────────────────────────────
export function getIO(): SocketIOServer {
  if (!io) throw new Error('Socket.IO has not been initialized. Call initSocket() first.');
  return io;
}
