import pino from 'pino'

const createLogger = (pino as any).default ?? pino
const stdSerializers = (pino as any).stdSerializers ?? (pino as any).default?.stdSerializers

export const logger = createLogger({
  level: process.env.LOG_LEVEL ?? 'info',
  serializers: {
    err: stdSerializers?.err,
  },
  transport:
    process.env.NODE_ENV !== 'production'
      ? { target: 'pino-pretty', options: { colorize: true, translateTime: 'SYS:HH:MM:ss' } }
      : undefined,
})

export type Logger = typeof logger
