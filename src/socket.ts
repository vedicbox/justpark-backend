import { Server as SocketIOServer } from 'socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import type { Server as HttpServer } from 'http';
import { redis, redisSub } from './config/redis';
import { env, isDev } from './config/env';

let _io: SocketIOServer | null = null;

// ─────────────────────────────────────────────
// initSocket — called once in server.ts after the http.Server is created.
// Attaches Socket.IO to the HTTP server and wires up the Redis adapter so
// events emitted on one process instance are broadcast to all other nodes.
// ─────────────────────────────────────────────
export function initSocket(server: HttpServer): SocketIOServer {
  const allowedOrigins = env.FRONTEND_ORIGINS.split(',').map((o) => o.trim());
  // Mirror the dev fallback origins from app.ts so the socket handshake
  // succeeds in the same environments where the REST API is reachable.
  const devFallbackOrigins = ['http://localhost:5173', 'http://localhost:3002'];

  _io = new SocketIOServer(server, {
    cors: {
      origin: (origin, callback) => {
        if (!origin) return callback(null, true);
        if (allowedOrigins.includes(origin)) return callback(null, true);
        if (isDev && devFallbackOrigins.includes(origin)) return callback(null, true);
        callback(new Error(`Socket.IO CORS: origin ${origin} not allowed`));
      },
      credentials: true,
    },
    // Use both WebSocket and long-polling so clients behind restrictive proxies
    // can still connect. WebSocket is preferred when available.
    transports: ['websocket', 'polling'],
  });

  // ── Redis adapter ─────────────────────────────────────────────────────────
  // pubClient  (redis)    — publishes socket events to Redis Pub/Sub channel.
  // subClient  (redisSub) — subscribes to that channel and fans out to local
  //                         sockets on this process.
  // Both are the existing ioredis connections from src/config/redis.ts;
  // they are already connected by the time initSocket() is called.
  _io.adapter(createAdapter(redis, redisSub));

  _io.on('connection', (socket) => {
    socket.on('disconnect', () => {
      // Per-socket cleanup (room leave, online-status TTL expiry) is handled
      // by individual feature modules that call getIO().
    });
  });

  return _io;
}

// ─────────────────────────────────────────────
// getIO — returns the singleton Socket.IO server for use in service/job layers.
// Throws if called before initSocket() so misuse is caught at startup.
// ─────────────────────────────────────────────
export function getIO(): SocketIOServer {
  if (!_io) {
    throw new Error('Socket.IO has not been initialized. Call initSocket() first.');
  }
  return _io;
}
