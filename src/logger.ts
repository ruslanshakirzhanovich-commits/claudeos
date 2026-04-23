import pino from 'pino'

const createLogger = (pino as any).default ?? pino
const stdSerializers = (pino as any).stdSerializers ?? (pino as any).default?.stdSerializers

// Redact obvious secret-bearing fields. grammy / discord.js / baileys can
// attach full request configs (headers, tokens, api keys) to error objects;
// without this, a single network failure dumps our bot token straight into
// the log. Pino's redact wildcards only span a single path segment, so the
// list has to cover the common shapes explicitly.
export const REDACT_PATHS: readonly string[] = [
  'token',
  'apiKey',
  'api_key',
  'password',
  'secret',
  'Authorization',
  'authorization',
  '*.token',
  '*.apiKey',
  '*.api_key',
  '*.password',
  '*.secret',
  '*.Authorization',
  '*.authorization',
  '*.headers.authorization',
  '*.headers.Authorization',
  '*.headers["x-telegram-bot-api-secret-token"]',
  '*.config.headers.authorization',
  '*.config.headers.Authorization',
  '*.request.headers.authorization',
  '*.request.headers.Authorization',
  'err.config.headers.authorization',
  'err.config.headers.Authorization',
  'err.request.headers.authorization',
  'err.request.headers.Authorization',
]

export const logger = createLogger({
  level: process.env.LOG_LEVEL ?? 'info',
  redact: {
    paths: [...REDACT_PATHS],
    censor: '[redacted]',
  },
  serializers: {
    err: stdSerializers?.err,
  },
  transport:
    process.env.NODE_ENV !== 'production'
      ? { target: 'pino-pretty', options: { colorize: true, translateTime: 'SYS:HH:MM:ss' } }
      : undefined,
})

export type Logger = typeof logger
