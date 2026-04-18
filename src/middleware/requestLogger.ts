import { Request, Response } from 'express';
import pinoHttp from 'pino-http';
import { env, isDev } from '../config/env';
import { logger } from '../utils/logger';

export const requestLogger = pinoHttp({
  logger,
  autoLogging: {
    ignore: (req) => {
      // Skip health check logs to reduce noise
      return req.url === '/health' || req.url === '/favicon.ico';
    },
  },
  customLogLevel: (_req, res, err) => {
    if (err || res.statusCode >= 500) return 'error';
    if (res.statusCode >= 400) return 'warn';
    return 'info';
  },
  customSuccessMessage: (req, res) => {
    return `${req.method} ${req.url} ${res.statusCode}`;
  },
  customErrorMessage: (req, res, err) => {
    return `${req.method} ${req.url} ${res.statusCode} — ${err.message}`;
  },
  serializers: {
    req: (req: Request) => ({
      id: req.id,
      method: req.method,
      url: req.url,
      // Redact sensitive headers
      headers: {
        'content-type': req.headers['content-type'],
        'user-agent': req.headers['user-agent'],
        'x-forwarded-for': req.headers['x-forwarded-for'],
      },
    }),
    res: (res: Response) => ({
      statusCode: res.statusCode,
    }),
  },
  ...(isDev && {
    transport: {
      target: 'pino-pretty',
      options: {
        colorize: true,
        translateTime: 'SYS:HH:MM:ss',
        ignore: 'pid,hostname,req.headers',
        messageFormat: '{req.method} {req.url} → {res.statusCode} ({responseTime}ms)',
      },
    },
  }),
  genReqId: (req) => {
    return (req.headers['x-request-id'] as string) ?? crypto.randomUUID();
  },
  // Don't log body — may contain sensitive data
  customAttributeKeys: {
    req: 'req',
    res: 'res',
    err: 'err',
    responseTime: 'responseTime',
  },
  ...(env.NODE_ENV === 'production' && {
    redact: {
      paths: [
        'req.headers.authorization',
        'req.headers.cookie',
        'req.body.password',
      ],
      censor: '[REDACTED]',
    },
  }),
});
