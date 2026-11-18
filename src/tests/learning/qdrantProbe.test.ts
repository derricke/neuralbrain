import http from 'http';
import net from 'net';
import { AddressInfo } from 'net';
import request from 'supertest';
import { resetDb } from '../../lib/db';
import { probeQdrant, QDRANT_PROBE_TIMEOUT_MS } from '../../learning/embedWorker';
import { createApp } from '../../app';

/**
 * /health used to hang ~10 s when Qdrant accepted the connection but never
 * answered (a docker-mode Qdrant whose port is not published behaves like
 * this on WSL). The probe now gives up after a short timeout.
 */
describe('Qdrant status probe', () => {
  const savedUrl = process.env.QDRANT_URL;
  const savedKey = process.env.QDRANT_API_KEY;
  const servers: Array<net.Server | http.Server> = [];
  const sockets: net.Socket[] = [];

  beforeAll(() => {
    process.env.DATABASE_URL = ':memory:';
    process.env.BRAIN_EMBED = 'none';
    delete process.env.QDRANT_API_KEY;
    resetDb();
  });

  afterEach(async () => {
    sockets.splice(0).forEach((s) => s.destroy());
    await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(() => r(undefined)))));
  });

  afterAll(() => {
    if (savedUrl === undefined) delete process.env.QDRANT_URL;
    else process.env.QDRANT_URL = savedUrl;
    if (savedKey !== undefined) process.env.QDRANT_API_KEY = savedKey;
    resetDb();
  });

  /** Accepts connections and never responds. */
  async function blackhole(): Promise<string> {
    const server = net.createServer((socket) => {
      sockets.push(socket);
    });
    servers.push(server);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }

  /** Answers GET /collections like Qdrant does. */
  async function fakeQdrant(): Promise<string> {
    const server = http.createServer((_req, res) => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ result: { collections: [] }, status: 'ok', time: 0 }));
    });
    servers.push(server);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }

  test('reports offline within the timeout when Qdrant never answers', async () => {
    process.env.QDRANT_URL = await blackhole();
    const started = Date.now();
    await expect(probeQdrant(300)).resolves.toBe('offline');
    expect(Date.now() - started).toBeLessThan(2000);
  });

  test('reports ok when Qdrant answers', async () => {
    process.env.QDRANT_URL = await fakeQdrant();
    await expect(probeQdrant()).resolves.toBe('ok');
  });

  test('reports offline when nothing is listening', async () => {
    const tmp = net.createServer();
    await new Promise<void>((r) => tmp.listen(0, '127.0.0.1', () => r()));
    const port = (tmp.address() as AddressInfo).port;
    await new Promise((r) => tmp.close(() => r(undefined)));
    process.env.QDRANT_URL = `http://127.0.0.1:${port}`;
    await expect(probeQdrant()).resolves.toBe('offline');
  });

  test('GET /health answers promptly with qdrant: offline when Qdrant hangs', async () => {
    process.env.QDRANT_URL = await blackhole();
    const app = createApp();
    const started = Date.now();
    const res = await request(app).get('/health');
    const elapsed = Date.now() - started;

    expect(res.status).toBe(200);
    expect(res.body.qdrant).toBe('offline');
    expect(elapsed).toBeLessThan(QDRANT_PROBE_TIMEOUT_MS + 1500);
  });
});
