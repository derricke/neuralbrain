import { describe, it, expect, beforeEach, afterEach } from '@jest/globals';
import { redactSecrets } from '../../lib/redactSecrets';
import { getDb, resetDb } from '../../lib/db';
import { captureObservations } from '../../memory/observationStore';
import { createNote } from '../../memory/noteStore';

describe('redactSecrets', () => {
  it('redacts known API key and token formats', () => {
    const samples = [
      'ANTHROPIC_API_KEY=sk-ant-api03-1234567890abcdef1234567890',
      'OPENAI_API_KEY=sk-proj-abcdefghijklmnopqrstuvwxyz1234',
      'STRIPE_KEY=sk_live_51AbCdEfGhIjKlMnOpQrStUv',
      'GOOGLE_KEY=AIzaSyDummyKeyValue1234567890abcdefghijk',
      'GITHUB=ghp_1234567890abcdefghijklmnopqrstuvwx',
      'GH_PAT=github_pat_1234567890abcdef_1234567890abcdef',
      'AWS=AKIAIOSFODNN7EXAMPLE',
      'SLACK=xoxb-123456789012-1234567890123-abcdefghijklmnop',
      'HF=hf_abcdefghijklmnopqrstuvwxyz1234',
      'Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.payload.sig',
      'postgres://admin:superSecretPass123@db.internal:5432/prod',
      '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA...\n-----END RSA PRIVATE KEY-----',
    ];

    for (const sample of samples) {
      const redacted = redactSecrets(sample);
      expect(redacted).not.toBe(sample);
      expect(redacted).toContain('[REDACTED');
    }
  });

  it('does not redact normal code, UUIDs, or short test placeholders', () => {
    const safe = [
      'id=550e8400-e29b-41d4-a716-446655440000',
      'commit f61e151a74dff8680b477a5e632b4d591ec571bb',
      'process.env.OPENAI_API_KEY = "sk-test"',
      'src/learning/embedding.ts:241',
    ];

    for (const line of safe) {
      expect(redactSecrets(line)).toBe(line);
    }
  });
});

describe('server-side secret redaction on capture & notes', () => {
  beforeEach(() => {
    process.env.DATABASE_URL = ':memory:';
    process.env.BRAIN_EMBED = 'none';
    resetDb();
    getDb();
  });

  afterEach(() => {
    resetDb();
  });

  it('redacts secrets in captured observations before storing', () => {
    const res = captureObservations([
      {
        scope: 'project',
        project_id: 'neuralbrain',
        kind: 'tool_call',
        tool_name: 'Bash',
        input: 'curl -H "Authorization: Bearer super_secret_bearer_token_123456" https://api.example.com',
        output: 'found key ghp_1234567890abcdefghijklmnopqrstuvwx in .env',
      },
    ]);

    expect(res.accepted).toBe(1);
    const { getDb } = require('../../lib/db');
    const row = getDb().prepare('SELECT input, output FROM observations WHERE id = ?').get(res.ids[0]) as {
      input: string;
      output: string;
    };
    expect(row.input).not.toContain('super_secret_bearer_token_123456');
    expect(row.input).toContain('Bearer [REDACTED_TOKEN]');
    expect(row.output).not.toContain('ghp_1234567890abcdefghijklmnopqrstuvwx');
    expect(row.output).toContain('[REDACTED_TOKEN]');
  });

  it('redacts secrets in saved notes (title & content)', () => {
    const note = createNote({
      scope: 'project',
      project_id: 'neuralbrain',
      type: 'fact',
      title: 'Config note with AIzaSyDummyKeyValue1234567890abcdefghijk',
      content: 'Use postgres://app:mySecretPass99@localhost:5432/db and sk-ant-api03-1234567890abcdef1234567890',
    });

    expect(note.title).not.toContain('AIzaSyDummyKeyValue1234567890abcdefghijk');
    expect(note.title).toContain('[REDACTED_API_KEY]');
    expect(note.content).not.toContain('mySecretPass99');
    expect(note.content).toContain('[REDACTED_PASSWORD]');
    expect(note.content).not.toContain('sk-ant-api03-1234567890abcdef1234567890');
  });
});
