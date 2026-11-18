import { spawnSync } from 'child_process';
import fs from 'fs';
import https from 'https';
import path from 'path';
import tls from 'tls';
import { getBrainHomeDir } from './brainHome';

export interface EnsureLocalTlsCertsOptions {
  homeDir?: string;
  certPath?: string;
  keyPath?: string;
}

export interface EnsureLocalTlsCertsResult {
  certPath: string;
  keyPath: string;
  generated: boolean;
}

/**
 * Returns the default directory for locally generated TLS certificates (~/.neuralbrain/certs).
 */
export function getDefaultCertsDir(homeDir?: string): string {
  if (!homeDir && process.env.BRAIN_CERTS_DIR?.trim()) {
    return path.resolve(process.env.BRAIN_CERTS_DIR.trim());
  }
  return path.join(getBrainHomeDir(homeDir), 'certs');
}

/**
 * Ensures local TLS certificate and private key files exist.
 * Uses explicit certPath/keyPath (or BRAIN_TLS_CERT/BRAIN_TLS_KEY) when provided,
 * otherwise generates a self-signed localhost certificate in ~/.neuralbrain/certs/.
 */
export function ensureLocalTlsCerts(
  options?: EnsureLocalTlsCertsOptions
): EnsureLocalTlsCertsResult {
  const explicitCert = options?.certPath?.trim() || process.env.BRAIN_TLS_CERT?.trim();
  const explicitKey = options?.keyPath?.trim() || process.env.BRAIN_TLS_KEY?.trim();

  if (explicitCert || explicitKey) {
    if (!explicitCert || !explicitKey) {
      throw new Error(
        'Both certPath and keyPath (or BRAIN_TLS_CERT and BRAIN_TLS_KEY) must be provided together.'
      );
    }
    const certPath = path.resolve(explicitCert);
    const keyPath = path.resolve(explicitKey);
    if (!fs.existsSync(certPath)) {
      throw new Error(`TLS certificate file not found: ${certPath}`);
    }
    if (!fs.existsSync(keyPath)) {
      throw new Error(`TLS private key file not found: ${keyPath}`);
    }
    return { certPath, keyPath, generated: false };
  }

  const certsDir = getDefaultCertsDir(options?.homeDir);
  const certPath = path.join(certsDir, 'server.crt');
  const keyPath = path.join(certsDir, 'server.key');

  if (fs.existsSync(certPath) && fs.existsSync(keyPath)) {
    return { certPath, keyPath, generated: false };
  }

  fs.mkdirSync(certsDir, { recursive: true, mode: 0o700 });

  const res = spawnSync(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-keyout',
      keyPath,
      '-out',
      certPath,
      '-days',
      '365',
      '-subj',
      '/CN=localhost',
      '-addext',
      'subjectAltName=DNS:localhost,IP:127.0.0.1,IP:::1',
    ],
    { encoding: 'utf8' }
  );

  if (res.error || res.status !== 0) {
    const detail = res.error?.message || res.stderr?.trim() || `exit code ${res.status}`;
    throw new Error(`Failed to generate local TLS certificate with openssl: ${detail}`);
  }

  if (!fs.existsSync(certPath) || !fs.existsSync(keyPath)) {
    throw new Error('openssl completed without creating server.crt and server.key');
  }

  fs.chmodSync(keyPath, 0o600);
  return { certPath, keyPath, generated: true };
}

/**
 * Resolves the local TLS certificate path from BRAIN_TLS_CERT or ~/.neuralbrain/certs/server.crt.
 */
export function getLocalTlsCertPath(homeDir?: string): string {
  return process.env.BRAIN_TLS_CERT?.trim() || path.join(getDefaultCertsDir(homeDir), 'server.crt');
}

function normalizeHeaders(headers?: RequestInit['headers']): Record<string, string> {
  const out: Record<string, string> = {};
  if (!headers) return out;
  if (headers instanceof Headers) {
    headers.forEach((value, key) => {
      out[key] = value;
    });
    return out;
  }
  if (Array.isArray(headers)) {
    for (const [key, value] of headers) {
      out[key] = value;
    }
    return out;
  }
  for (const [key, value] of Object.entries(headers)) {
    if (value !== undefined) {
      out[key] = String(value);
    }
  }
  return out;
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  return normalized === '127.0.0.1' || normalized === 'localhost' || normalized === '::1';
}

/**
 * Returns a fetch implementation that trusts the local self-signed Brain TLS certificate
 * for loopback HTTPS requests (or any host when BRAIN_TLS_CERT / options.certPath is set),
 * falling back to globalThis.fetch for HTTP and standard remote HTTPS endpoints.
 */
export function createLocalTlsFetch(options?: {
  certPath?: string;
  homeDir?: string;
}): typeof fetch {
  return async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const rawUrl = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const parsedUrl = new URL(rawUrl);
    const explicitCert = options?.certPath?.trim() || process.env.BRAIN_TLS_CERT?.trim();
    const certPath = explicitCert || getLocalTlsCertPath(options?.homeDir);
    const shouldUseCustomCa =
      parsedUrl.protocol === 'https:' &&
      (Boolean(explicitCert) || isLoopbackHostname(parsedUrl.hostname)) &&
      fs.existsSync(certPath);

    if (!shouldUseCustomCa) {
      return globalThis.fetch(input, init);
    }

    const ca = [...tls.rootCertificates, fs.readFileSync(certPath, 'utf8')];
    const method = init?.method || (input instanceof Request ? input.method : 'GET');
    const headers = normalizeHeaders(
      init?.headers ?? (input instanceof Request ? input.headers : undefined)
    );
    const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined);

    let bodyBuffer: Buffer | undefined;
    const rawBody = init?.body;
    if (typeof rawBody === 'string') {
      bodyBuffer = Buffer.from(rawBody, 'utf8');
    } else if (rawBody instanceof Uint8Array) {
      bodyBuffer = Buffer.from(rawBody);
    } else if (rawBody instanceof ArrayBuffer) {
      bodyBuffer = Buffer.from(rawBody);
    } else if (rawBody != null) {
      return globalThis.fetch(input, init);
    }

    if (bodyBuffer && !Object.keys(headers).some((k) => k.toLowerCase() === 'content-length')) {
      headers['Content-Length'] = String(bodyBuffer.byteLength);
    }

    return new Promise<Response>((resolve, reject) => {
      if (signal?.aborted) {
        reject(signal.reason ?? new DOMException('The operation was aborted.', 'AbortError'));
        return;
      }

      const req = https.request(
        {
          hostname: parsedUrl.hostname,
          port: parsedUrl.port || 443,
          path: `${parsedUrl.pathname}${parsedUrl.search}`,
          method,
          headers,
          ca,
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (chunk: Buffer | string) => {
            chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
          });
          res.on('end', () => {
            cleanup();
            const status = res.statusCode ?? 200;
            const resHeaders = new Headers();
            for (const [key, value] of Object.entries(res.headers)) {
              if (Array.isArray(value)) {
                for (const item of value) resHeaders.append(key, item);
              } else if (value !== undefined) {
                resHeaders.set(key, value);
              }
            }
            const emptyBodyStatus = status === 101 || status === 204 || status === 205 || status === 304;
            const payload = emptyBodyStatus ? null : Buffer.concat(chunks);
            resolve(
              new Response(payload, {
                status,
                statusText: res.statusMessage || '',
                headers: resHeaders,
              })
            );
          });
        }
      );

      const onAbort = () => {
        cleanup();
        const reason = signal?.reason ?? new DOMException('The operation was aborted.', 'AbortError');
        req.destroy(reason instanceof Error ? reason : new Error(String(reason)));
        reject(reason);
      };

      const cleanup = () => {
        signal?.removeEventListener('abort', onAbort);
      };

      signal?.addEventListener('abort', onAbort, { once: true });

      req.on('error', (err) => {
        cleanup();
        reject(err);
      });

      if (bodyBuffer) {
        req.write(bodyBuffer);
      }
      req.end();
    });
  };
}
