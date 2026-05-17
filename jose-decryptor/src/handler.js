'use strict';

const { getSecret } = require('./secretsManager');
const { decryptToken } = require('./decryptor');

// Module-level cache — persists across warm invocations within the same container.
// Stores the imported CryptoKey so Secrets Manager is only called on cold start.
let cachedPrivateKey = null;

/**
 * Lazily retrieves and caches the RSA private key from AWS Secrets Manager.
 * On cold start the PEM is fetched and imported with importPKCS8; subsequent
 * calls return the cached CryptoKey without hitting Secrets Manager again.
 *
 * @returns {Promise<CryptoKey>} The imported RSA private key (CryptoKey).
 */
async function getKey() {
  
  if (!cachedPrivateKey) {
    const pem = await getSecret(process.env.PRIVATE_KEY_SECRET_NAME);
    // jose v5 is ESM-only; dynamic import() is required from CommonJS.
    const { importPKCS8 } = await import('jose');
    cachedPrivateKey = await importPKCS8(pem, 'RSA-OAEP-256');
  }
  
  return cachedPrivateKey;
}

/**
 * Validates that a string is a well-formed JWE Compact Serialization token.
 *
 * Checks:
 *  1. Exactly 5 dot-separated parts.
 *  2. The decoded protected header declares alg: 'RSA-OAEP-256' and enc: 'A256GCM'.
 *
 * @param {string} token
 * @returns {boolean}
 */
function isValidJWEFormat(token) {
  if (typeof token !== 'string') return false;

  const parts = token.split('.');
  if (parts.length !== 5) return false;

  // Decode and parse the protected header (first part, base64url-encoded)
  try {
    const headerJson = Buffer.from(parts[0], 'base64url').toString('utf8');
    const header = JSON.parse(headerJson);
    return header.alg === 'RSA-OAEP-256' && header.enc === 'A256GCM';
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Response helpers
// ---------------------------------------------------------------------------

const HEADERS = { 'Content-Type': 'application/json' };

function errorResponse(statusCode, message) {
  return {
    statusCode,
    headers: HEADERS,
    body: JSON.stringify({ error: message }),
  };
}

function successResponse(data) {
  return {
    statusCode: 200,
    headers: HEADERS,
    body: JSON.stringify(data),
  };
}

// ---------------------------------------------------------------------------
// Lambda handler
// ---------------------------------------------------------------------------

/**
 * AWS Lambda entry point for the jose-decryptor function.
 *
 * Expected event shape: { token: "a.b.c.d.e" }
 *
 * Validates the token, retrieves (and caches) the RSA private key from
 * Secrets Manager, decrypts the JWE token, and returns the payload in the
 * response body.
 *
 * Error mapping:
 *   ERR_JWE_DECRYPTION_FAILED + "integrity"/"tag" in message → 422 integrity failure
 *   ERR_JWE_DECRYPTION_FAILED (other)                        → 422 key mismatch
 *   Any other decryption error                               → 500
 *
 * @param {object} event - Lambda invocation event.
 * @returns {Promise<object>} API Gateway proxy-compatible response.
 */
exports.handler = async (event) => {
  // 1. Validate presence of token field.
  if (!('token' in event) || event.token === undefined) {
    return errorResponse(400, 'Missing required field: token');
  }

  // 2. Validate JWE format (5 parts + correct algorithms in header).
  if (!isValidJWEFormat(event.token)) {
    return errorResponse(400, 'Invalid token format: must be a valid JWE Compact Serialization');
  }

  // 3. Retrieve (and cache) the private key.
  let privateKey;
  try {
    privateKey = await getKey();
  } catch (e) {
    return errorResponse(500, 'Failed to retrieve decryption key');
  }

  // 4. Decrypt the token with differentiated error handling.
  try {
    const payload = await decryptToken(event.token, privateKey);
    return successResponse({ payload });
  } catch (e) {
    if (e.code === 'ERR_JWE_DECRYPTION_FAILED') {
      // Both key mismatch and AES-GCM integrity failures share this error code.
      // Distinguish them by inspecting the error message for integrity-related keywords.
      const msg = (e.message || '').toLowerCase();
      if (msg.includes('integrity') || msg.includes('tag')) {
        return errorResponse(422, 'Decryption failed: token integrity check failed');
      }
      return errorResponse(422, 'Decryption failed: key mismatch');
    }
    return errorResponse(500, 'Decryption failed');
  }
};

// Exported for unit testing.
exports._resetCache = () => { cachedPrivateKey = null; };
exports._isValidJWEFormat = isValidJWEFormat;
