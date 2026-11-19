import pino from 'pino';

const redact = ['req.headers.authorization', 'apiKey', 'rawKey', 'key'];

export const logger = pino(
  process.env.NODE_ENV === 'production'
    ? { redact }
    : { redact, transport: { target: 'pino-pretty', options: { colorize: true } } }
);
