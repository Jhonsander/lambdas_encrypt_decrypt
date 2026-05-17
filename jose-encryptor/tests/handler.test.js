'use strict';

/**
 * Unit tests for jose-encryptor handler.
 * Validates: Requirements 5.1, 5.2, 5.5
 *
 * Mocking strategy:
 *   - ../src/secretsManager is mocked directly so no real AWS connectivity is needed.
 *   - ../src/encryptor is replaced with a real implementation that uses require('jose')
 *     instead of dynamic import('jose'), so Jest's CommonJS environment handles it
 *     correctly without --experimental-vm-modules.
 *   - A real RSA key pair is generated with Node.js crypto so actual JWE operations work.
 *   - jest.resetModules() + jest.doMock() is used before each require so the key cache
 *     is always cleared and the mock is always fresh.
 */

const crypto = require('crypto');
const { importSPKI, CompactEncrypt } = require('jose');

// ---------------------------------------------------------------------------
// Generate a real RSA key pair once for the entire test suite.
// The public key PEM is what the mock secretsManager will return.
// ---------------------------------------------------------------------------

const { publicKey: PUBLIC_KEY_PEM } = crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

// ---------------------------------------------------------------------------
// Set required environment variables
// ---------------------------------------------------------------------------
beforeAll(() => {
  process.env.PUBLIC_KEY_SECRET_NAME = 'test/public-key';
  process.env.AWS_REGION = 'us-east-1';
});

// ---------------------------------------------------------------------------
// Real encryptPayload implementation using require('jose') instead of import('jose').
// This avoids Jest's dynamic import() restriction in CommonJS mode.
// The crypto operations are real and end-to-end correct.
// ---------------------------------------------------------------------------
async function realEncryptPayload(payload, publicKeyOrPem) {
  const publicKey =
    typeof publicKeyOrPem === 'string'
      ? await importSPKI(publicKeyOrPem, 'RSA-OAEP-256')
      : publicKeyOrPem;
  const plaintext = new TextEncoder().encode(JSON.stringify(payload));
  return new CompactEncrypt(plaintext)
    .setProtectedHeader({ alg: 'RSA-OAEP-256', enc: 'A256GCM' })
    .encrypt(publicKey);
}

// ---------------------------------------------------------------------------
// Helper: load a fresh handler with mocked secretsManager and encryptor.
// Uses jest.resetModules() + jest.doMock() so the module cache is cleared
// and mocks are registered before the handler (and its deps) are loaded.
// ---------------------------------------------------------------------------
function loadHandlerWithSecret(getSecretImpl) {
  jest.resetModules();
  jest.doMock('../src/secretsManager', () => ({
    getSecret: getSecretImpl,
  }));
  // Replace encryptor with a real implementation that uses require('jose')
  // so Jest doesn't encounter dynamic import() calls.
  jest.doMock('../src/encryptor', () => ({
    encryptPayload: realEncryptPayload,
  }));
  return require('../src/handler');
}

// Default getSecret: returns the real public key PEM
function defaultGetSecret() {
  return jest.fn().mockResolvedValue(PUBLIC_KEY_PEM);
}

// Failing getSecret: simulates a Secrets Manager error
function failingGetSecret() {
  return jest.fn().mockRejectedValue(new Error('AccessDeniedException'));
}

// ---------------------------------------------------------------------------
// Tests — Requirement 5.1
// ---------------------------------------------------------------------------

describe('jose-encryptor handler — valid payload', () => {
  test('Valid payload → HTTP 200 with token having exactly 5 dot-separated parts', async () => {
    const handler = loadHandlerWithSecret(defaultGetSecret());
    const event = { payload: { userId: '123', data: 'sensitive' } };

    const result = await handler.handler(event);

    expect(result.statusCode).toBe(200);
    const body = JSON.parse(result.body);
    expect(typeof body.token).toBe('string');
    const parts = body.token.split('.');
    expect(parts).toHaveLength(5);
  });
});

// ---------------------------------------------------------------------------
// Tests — Requirement 5.2
// ---------------------------------------------------------------------------

describe('jose-encryptor handler — invalid payload inputs → HTTP 400', () => {
  test('Event without `payload` field → HTTP 400 with "Missing required field: payload"', async () => {
    const handler = loadHandlerWithSecret(defaultGetSecret());
    const result = await handler.handler({});

    expect(result.statusCode).toBe(400);
    expect(JSON.parse(result.body).error).toBe('Missing required field: payload');
  });

  test('payload is a string → HTTP 400 with "Invalid payload: must be a non-empty valid JSON object"', async () => {
    const handler = loadHandlerWithSecret(defaultGetSecret());
    const result = await handler.handler({ payload: 'hello' });

    expect(result.statusCode).toBe(400);
    expect(JSON.parse(result.body).error).toBe(
      'Invalid payload: must be a non-empty valid JSON object'
    );
  });

  test('payload is a number → HTTP 400', async () => {
    const handler = loadHandlerWithSecret(defaultGetSecret());
    const result = await handler.handler({ payload: 42 });

    expect(result.statusCode).toBe(400);
    expect(JSON.parse(result.body).error).toBe(
      'Invalid payload: must be a non-empty valid JSON object'
    );
  });

  test('payload is an array → HTTP 400', async () => {
    const handler = loadHandlerWithSecret(defaultGetSecret());
    const result = await handler.handler({ payload: [1, 2, 3] });

    expect(result.statusCode).toBe(400);
    expect(JSON.parse(result.body).error).toBe(
      'Invalid payload: must be a non-empty valid JSON object'
    );
  });

  test('payload is null → HTTP 400', async () => {
    const handler = loadHandlerWithSecret(defaultGetSecret());
    const result = await handler.handler({ payload: null });

    expect(result.statusCode).toBe(400);
    expect(JSON.parse(result.body).error).toBe(
      'Invalid payload: must be a non-empty valid JSON object'
    );
  });

  test('payload is {} (empty object) → HTTP 400', async () => {
    const handler = loadHandlerWithSecret(defaultGetSecret());
    const result = await handler.handler({ payload: {} });

    expect(result.statusCode).toBe(400);
    expect(JSON.parse(result.body).error).toBe(
      'Invalid payload: must be a non-empty valid JSON object'
    );
  });

  test('payload > 256 KB → HTTP 400 with "Payload too large: maximum size is 256KB"', async () => {
    const handler = loadHandlerWithSecret(defaultGetSecret());
    // Create a payload whose JSON serialization exceeds 256 KB
    const bigPayload = { data: 'x'.repeat(300 * 1024) };
    const result = await handler.handler({ payload: bigPayload });

    expect(result.statusCode).toBe(400);
    expect(JSON.parse(result.body).error).toBe('Payload too large: maximum size is 256KB');
  });
});

// ---------------------------------------------------------------------------
// Tests — Requirement 5.5 (Secrets Manager failure → HTTP 500)
// ---------------------------------------------------------------------------

describe('jose-encryptor handler — Secrets Manager failure', () => {
  test('Secrets Manager failure → HTTP 500 with "Failed to retrieve encryption key"', async () => {
    const handler = loadHandlerWithSecret(failingGetSecret());
    const result = await handler.handler({ payload: { userId: '1' } });

    expect(result.statusCode).toBe(500);
    expect(JSON.parse(result.body).error).toBe('Failed to retrieve encryption key');
  });
});
