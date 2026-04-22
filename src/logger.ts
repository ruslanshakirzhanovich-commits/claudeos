import pino from 'pino'

const createLogger = (pino as any).default ?? pino

export const logger = createLogger({
  level: process.env.LOG_LEVEL ?? 'info',
  transport:
    process.env.NODE_ENV !== 'production'
      ? { target: 'pino-pretty', options: { colorize: true, translateTime: 'SYS:HH:MM:ss' } }
      : undefined,
})

export type Logger = typeof logger
