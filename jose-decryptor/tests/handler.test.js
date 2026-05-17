'use strict';

/**
 * Unit tests for jose-decryptor handler.
 * Validates: Requirements 5.3, 5.4, 5.5
 *
 * Mocking strategy:
 *   - @aws-sdk/client-secrets-manager is mocked so no real AWS connectivity is needed.
 *   - A real RSA key pair is generated with Node.js crypto so actual JWE operations work.
 *   - A second RSA key pair is generated to simulate key mismatch scenarios.
 *   - The handler's _resetCache() helper is called between tests that need fresh state.
 */

const crypto = require('crypto');

// ---------------------------------------------------------------------------
// Generate two real RSA key pairs:
//   Pair A — the "correct" pair used by the mock Secrets Manager
//   Pair B — a "different" pair used to produce tokens that won't decrypt
// ---------------------------------------------------------------------------
const { privateKey: PRIVATE_KEY_PEM_A, publicKey: PUBLIC_KEY_PEM_A } =
  crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });

const { privateKey: _privB, publicKey: PUBLIC_KEY_PEM_B } =
  crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  });

// ---------------------------------------------------------------------------
// Mock @aws-sdk/client-secrets-manager BEFORE requiring the handler.
// The mock's send() resolves with the correct private key PEM by default.
// Individual tests can override mockSend to simulate failures.
// ---------------------------------------------------------------------------
let mockSend = jest.fn().mockResolvedValue({ SecretString: PRIVATE_KEY_PEM_A });

jest.mock('@aws-sdk/client-secrets-manager', () => {
  return {
    SecretsManagerClient: jest.fn().mockImplementation(() => ({
      send: (...args) => mockSend(...args),
    })),
    GetSecretValueCommand: jest.fn().mockImplementation((params) => params),
  };
});

// ---------------------------------------------------------------------------
// Helper: load a fresh handler module (bypasses module cache + key cache).
// ---------------------------------------------------------------------------
function loadHandler() {
  jest.resetModules();
  jest.mock('@aws-sdk/client-secrets-manager', () => {
    return {
      SecretsManagerClient: jest.fn().mockImplementation(() => ({
        send: (...args) => mockSend(...args),
      })),
      GetSecretValueCommand: jest.fn().mockImplementation((params) => params),
    };
  });
  return require('../src/handler');
}

// ---------------------------------------------------------------------------
// Helper: encrypt a payload with a given public key PEM using jose directly.
// Returns a JWE Compact Serialization token string.
// ---------------------------------------------------------------------------
async function encryptWithKey(payload, publicKeyPem) {
  const { importSPKI, CompactEncrypt } = require('jose');
  const publicKey = await importSPKI(publicKeyPem, 'RSA-OAEP-256');
  const plaintext = new TextEncoder().encode(JSON.stringify(payload));
  return new CompactEncrypt(plaintext)
    .setProtectedHeader({ alg: 'RSA-OAEP-256', enc: 'A256GCM' })
    .encrypt(publicKey);
}

// ---------------------------------------------------------------------------
// Set required environment variables
// ---------------------------------------------------------------------------
beforeAll(() => {
  process.env.PRIVATE_KEY_SECRET_NAME = 'test/private-key';
  process.env.AWS_REGION = 'us-east-1';
});

// Reset the mock and module cache before each test so the key cache is cleared.
beforeEach(() => {
  mockSend = jest.fn().mockResolvedValue({ SecretString: PRIVATE_KEY_PEM_A });
  jest.resetModules();
  jest.mock('@aws-sdk/client-secrets-manager', () => {
    return {
      SecretsManagerClient: jest.fn().mockImplementation(() => ({
        send: (...args) => mockSend(...args),
      })),
      GetSecretValueCommand: jest.fn().mockImplementation((params) => params),
    };
  });
});

// ---------------------------------------------------------------------------
// Tests — Requirement 5.3
// ---------------------------------------------------------------------------

describe('jose-decryptor handler — valid token', () => {
  test('Valid JWE token → HTTP 200 with original payload (deep equal)', async () => {
    const originalPayload = { userId: '123', data: 'sensitive information', nested: { key: 'value' } };
    const token = await encryptWithKey(originalPayload, PUBLIC_KEY_PEM_A);

    const handler = require('../src/handler');
    const result = await handler.handler({ token });

    expect(result.statusCode).toBe(200);
    const body = JSON.parse(result.body);
    expect(body.payload).toEqual(originalPayload);
  });
});

// ---------------------------------------------------------------------------
// Tests — Requirement 5.4
// ---------------------------------------------------------------------------

describe('jose-decryptor handler — invalid token inputs → HTTP 400', () => {
  test('Event without `token` field → HTTP 400 with "Missing required field: token"', async () => {
    const handler = require('../src/handler');
    const result = await handler.handler({});

    expect(result.statusCode).toBe(400);
    expect(JSON.parse(result.body).error).toBe('Missing required field: token');
  });

  test('token with 4 parts → HTTP 400 with "Invalid token format: must be a valid JWE Compact Serialization"', async () => {
    const handler = require('../src/handler');
    const result = await handler.handler({ token: 'part1.part2.part3.part4' });

    expect(result.statusCode).toBe(400);
    expect(JSON.parse(result.body).error).toBe(
      'Invalid token format: must be a valid JWE Compact Serialization'
    );
  });

  test('token with 6 parts → HTTP 400', async () => {
    const handler = require('../src/handler');
    const result = await handler.handler({ token: 'part1.part2.part3.part4.part5.part6' });

    expect(result.statusCode).toBe(400);
    expect(JSON.parse(result.body).error).toBe(
      'Invalid token format: must be a valid JWE Compact Serialization'
    );
  });
});

describe('jose-decryptor handler — decryption failures → HTTP 422', () => {
  test('token encrypted with different key → HTTP 422 with "Decryption failed: key mismatch"', async () => {
    // Encrypt with key pair B's public key, but the handler has key pair A's private key
    const token = await encryptWithKey({ secret: 'data' }, PUBLIC_KEY_PEM_B);

    const handler = require('../src/handler');
    const result = await handler.handler({ token });

    expect(result.statusCode).toBe(422);
    expect(JSON.parse(result.body).error).toBe('Decryption failed: key mismatch');
  });

  test('corrupted token → HTTP 422', async () => {
    // Create a valid token then corrupt the ciphertext (part index 3)
    const token = await encryptWithKey({ secret: 'data' }, PUBLIC_KEY_PEM_A);
    const parts = token.split('.');
    // Reverse the ciphertext bytes to corrupt it
    const corruptedCiphertext = Buffer.from(parts[3], 'base64url')
      .reverse()
      .toString('base64url');
    const corruptedToken = [parts[0], parts[1], parts[2], corruptedCiphertext, parts[4]].join('.');

    const handler = require('../src/handler');
    const result = await handler.handler({ token: corruptedToken });

    expect(result.statusCode).toBe(422);
  });
});

// ---------------------------------------------------------------------------
// Tests — Requirement 5.5 (Secrets Manager failure → HTTP 500)
// ---------------------------------------------------------------------------

describe('jose-decryptor handler — Secrets Manager failure', () => {
  test('Secrets Manager failure → HTTP 500 with "Failed to retrieve decryption key"', async () => {
    // Override the mock to simulate a Secrets Manager error
    mockSend = jest.fn().mockRejectedValue(new Error('AccessDeniedException'));

    const handler = require('../src/handler');
    const result = await handler.handler({ token: 'a.b.c.d.e' });

    // Note: 'a.b.c.d.e' passes the 5-part check but the header decode will fail
    // the algorithm validation, so we need a structurally valid token header.
    // Let's use a token with a valid RSA-OAEP-256/A256GCM header.
    // Build a fake token with correct header but garbage body.
    const validHeader = Buffer.from(
      JSON.stringify({ alg: 'RSA-OAEP-256', enc: 'A256GCM' })
    ).toString('base64url');
    const fakeToken = `${validHeader}.fake.fake.fake.fake`;

    const result2 = await handler.handler({ token: fakeToken });

    expect(result2.statusCode).toBe(500);
    expect(JSON.parse(result2.body).error).toBe('Failed to retrieve decryption key');
  });
});
