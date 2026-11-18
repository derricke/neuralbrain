import express, { Request, Response } from 'express';
import request from 'supertest';
import { createRateLimiter } from '../../middleware/rateLimiter';
import { requestTracing } from '../../middleware/tracing';

describe('rateLimiter', () => {
  it('allows requests within max limits and blocks excess with 429 and standard error shape', async () => {
    const app = express();
    app.use(requestTracing);
    const limiter = createRateLimiter({ windowMs: 10000, maxRequests: 3 });
    app.use(limiter);

    app.get('/api/test', (_req: Request, res: Response) => {
      res.json({ ok: true });
    });

    const res1 = await request(app).get('/api/test');
    expect(res1.status).toBe(200);

    const res2 = await request(app).get('/api/test');
    expect(res2.status).toBe(200);

    const res3 = await request(app).get('/api/test');
    expect(res3.status).toBe(200);

    const res4 = await request(app).get('/api/test');
    expect(res4.status).toBe(429);
    expect(res4.body.error).toBeDefined();
    expect(res4.body.error.code).toBe('RATE_LIMIT_EXCEEDED');
    expect(res4.body.error.trace_id).toBeDefined();
    expect(res4.body.retryAfter).toBeGreaterThan(0);
  });

  it('exempts /health and /capture routes completely from rate limiting', async () => {
    const app = express();
    app.use(requestTracing);
    // limit 1 request
    const limiter = createRateLimiter({ windowMs: 10000, maxRequests: 1 });
    app.use(limiter);

    app.get('/health', (_req: Request, res: Response) => {
      res.json({ status: 'ok' });
    });

    app.post('/capture/observations', (_req: Request, res: Response) => {
      res.status(201).json({ accepted: 1 });
    });

    // /health multiple times
    for (let i = 0; i < 5; i++) {
      const res = await request(app).get('/health');
      expect(res.status).toBe(200);
    }

    // /capture multiple times
    for (let i = 0; i < 5; i++) {
      const res = await request(app).post('/capture/observations');
      expect(res.status).toBe(201);
    }
  });
});
