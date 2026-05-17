import pino from 'pino';

const level = process.env.ROTHUNTER_LOG_LEVEL ?? process.env.LOG_LEVEL ?? 'info';

export const logger = pino({ level });
