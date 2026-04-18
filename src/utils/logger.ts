import pino from 'pino';
import { env, isDev } from '../config/env';

export const logger = pino({
  level: env.LOG_LEVEL,
  ...(isDev && {
    transport: {
      target: 'pino-pretty',
      options: {
        colorize: true,
        translateTime: 'SYS:standard',
        ignore: 'pid,hostname',
        messageFormat: '{msg}',
      },
    },
  }),
  ...(!isDev && {
    // Production: structured JSON logs
    formatters: {
      level: (label: string) => ({ level: label }),
    },
    timestamp: pino.stdTimeFunctions.isoTime,
    redact: {
      paths: [
        'req.headers.authorization',
        'req.headers.cookie',
        'body.password',
        'body.password_hash',
        'body.card_number',
        'body.cvv',
      ],
      censor: '[REDACTED]',
    },
  }),
});
