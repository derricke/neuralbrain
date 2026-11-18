import fs from 'fs';
import https from 'https';
import net from 'net';
import os from 'os';
import path from 'path';
import { createApp } from '../../app';
import { resetDb } from '../../lib/db';
import {
  createLocalTlsFetch,
  ensureLocalTlsCerts,
  getDefaultCertsDir,
} from '../../lib/tls';

/**
 * Returns a loopback URL on a port that was just bound and released, so connections
 * are refused immediately. Pointing QDRANT_URL here keeps /health's Qdrant probe from
 * reaching whatever the developer has on localhost:6333 (which can hang for 10s+ when
 * it is blackholed, e.g. an unpublished Docker port under WSL).
 */
async function getRefusingLoopbackUrl(): Promise<string> {
  const probe = net.createServer();
  await new Promise<void>((resolve, reject) => {
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => resolve());
  });
  const address = probe.address();
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  if (!address || typeof address === 'string') {
    throw new Error('Expected TCP address from probe server');
  }
  return `http://127.0.0.1:${address.port}`;
}

describe('local TLS certificate generation and HTTPS server', () => {
  const originalEnv = { ...process.env };
  let tmpRoot: string;
  let tmpHome: string;

  beforeEach(async () => {
    process.env = { ...originalEnv };
    delete process.env.BRAIN_HOME;
    delete process.env.BRAIN_TLS_CERT;
    delete process.env.BRAIN_TLS_KEY;
    delete process.env.BRAIN_CERTS_DIR;
    delete process.env.QDRANT_API_KEY;
    process.env.QDRANT_URL = await getRefusingLoopbackUrl();

    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'neuralbrain-tls-test-'));
    tmpHome = path.join(tmpRoot, 'home');
    fs.mkdirSync(tmpHome, { recursive: true });
  });

  afterEach(() => {
    resetDb();
    process.env = { ...originalEnv };
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  test('getDefaultCertsDir resolves to <tmpHome>/.neuralbrain/certs', () => {
    expect(getDefaultCertsDir(tmpHome)).toBe(path.join(tmpHome, '.neuralbrain', 'certs'));
  });

  test('ensureLocalTlsCerts generates server.crt and server.key on first call and reuses them on second call', () => {
    const first = ensureLocalTlsCerts({ homeDir: tmpHome });
    const expectedDir = getDefaultCertsDir(tmpHome);

    expect(first.generated).toBe(true);
    expect(first.certPath).toBe(path.join(expectedDir, 'server.crt'));
    expect(first.keyPath).toBe(path.join(expectedDir, 'server.key'));
    expect(fs.existsSync(first.certPath)).toBe(true);
    expect(fs.existsSync(first.keyPath)).toBe(true);

    const certPem = fs.readFileSync(first.certPath, 'utf8');
    const keyPem = fs.readFileSync(first.keyPath, 'utf8');
    expect(certPem).toContain('BEGIN CERTIFICATE');
    expect(keyPem).toContain('BEGIN PRIVATE KEY');

    const second = ensureLocalTlsCerts({ homeDir: tmpHome });
    expect(second.generated).toBe(false);
    expect(second.certPath).toBe(first.certPath);
    expect(second.keyPath).toBe(first.keyPath);
    expect(fs.readFileSync(second.certPath, 'utf8')).toBe(certPem);
    expect(fs.readFileSync(second.keyPath, 'utf8')).toBe(keyPem);
  });

  test('ensureLocalTlsCerts uses explicit certPath and keyPath and throws if missing or incomplete', () => {
    const generated = ensureLocalTlsCerts({ homeDir: tmpHome });
    const customDir = path.join(tmpRoot, 'custom-certs');
    fs.mkdirSync(customDir, { recursive: true });
    const customCert = path.join(customDir, 'custom.crt');
    const customKey = path.join(customDir, 'custom.key');
    fs.copyFileSync(generated.certPath, customCert);
    fs.copyFileSync(generated.keyPath, customKey);

    const explicit = ensureLocalTlsCerts({ certPath: customCert, keyPath: customKey });
    expect(explicit).toEqual({
      certPath: path.resolve(customCert),
      keyPath: path.resolve(customKey),
      generated: false,
    });

    expect(() =>
      ensureLocalTlsCerts({
        certPath: path.join(customDir, 'missing.crt'),
        keyPath: customKey,
      })
    ).toThrow(/TLS certificate file not found/);

    expect(() =>
      ensureLocalTlsCerts({
        certPath: customCert,
        keyPath: path.join(customDir, 'missing.key'),
      })
    ).toThrow(/TLS private key file not found/);

    expect(() => ensureLocalTlsCerts({ certPath: customCert })).toThrow(
      /Both certPath and keyPath/
    );
  });

  test('serves /health over HTTPS on 127.0.0.1:0 using generated cert and key', async () => {
    process.env.DATABASE_URL = ':memory:';
    process.env.BRAIN_EMBED = 'none';
    resetDb();

    const { certPath, keyPath } = ensureLocalTlsCerts({ homeDir: tmpHome });
    const app = createApp();
    const server = https.createServer(
      {
        cert: fs.readFileSync(certPath),
        key: fs.readFileSync(keyPath),
      },
      app
    );

    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => resolve());
    });

    try {
      const address = server.address();
      if (!address || typeof address === 'string') {
        throw new Error('Expected TCP address from HTTPS server');
      }

      const ca = fs.readFileSync(certPath);
      const response = await new Promise<{ statusCode: number; body: string }>((resolve, reject) => {
        const req = https.request(
          {
            hostname: '127.0.0.1',
            port: address.port,
            path: '/health',
            method: 'GET',
            ca,
          },
          (res) => {
            const chunks: Buffer[] = [];
            res.on('data', (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)));
            res.on('end', () => {
              resolve({
                statusCode: res.statusCode ?? 0,
                body: Buffer.concat(chunks).toString('utf8'),
              });
            });
          }
        );
        req.on('error', reject);
        req.end();
      });

      expect(response.statusCode).toBe(200);
      const parsed = JSON.parse(response.body);
      expect(parsed.status).toBe('ok');
      expect(parsed.db).toBe('ok');
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    }
  });

  test('createLocalTlsFetch trusts local self-signed cert for GET and POST over HTTPS', async () => {
    process.env.DATABASE_URL = ':memory:';
    process.env.BRAIN_EMBED = 'none';
    process.env.BRAIN_REQUIRE_API_KEY = '0';
    resetDb();

    const { certPath, keyPath } = ensureLocalTlsCerts({ homeDir: tmpHome });
    const app = createApp();
    const server = https.createServer(
      {
        cert: fs.readFileSync(certPath),
        key: fs.readFileSync(keyPath),
      },
      app
    );

    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => resolve());
    });

    try {
      const address = server.address();
      if (!address || typeof address === 'string') {
        throw new Error('Expected TCP address from HTTPS server');
      }

      const tlsFetch = createLocalTlsFetch({ homeDir: tmpHome });
      const baseUrl = `https://127.0.0.1:${address.port}`;

      const healthRes = await tlsFetch(`${baseUrl}/health`, {
        signal: AbortSignal.timeout(5000),
      });
      expect(healthRes.ok).toBe(true);
      expect(healthRes.status).toBe(200);
      const healthData = (await healthRes.json()) as { status: string; db: string };
      expect(healthData.status).toBe('ok');
      expect(healthData.db).toBe('ok');

      const searchRes = await tlsFetch(`${baseUrl}/search`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ q: 'test', grains: ['note'] }),
        signal: AbortSignal.timeout(5000),
      });
      expect(searchRes.ok).toBe(true);
      const searchData = (await searchRes.json()) as { results: unknown[] };
      expect(Array.isArray(searchData.results)).toBe(true);
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      });
    }
  });
});
