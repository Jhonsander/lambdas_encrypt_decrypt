'use strict';

const { getSecret } = require('./secretsManager');
const { encryptPayload } = require('./encryptor');

// Module-level cache — persists across warm invocations within the same container.
// Stores the imported CryptoKey so Secrets Manager is only called on cold start.
let cachedPublicKey = null;

/**
 * Lazily retrieves and caches the RSA public key from AWS Secrets Manager.
 * On cold start the PEM is fetched and imported with importSPKI; subsequent
 * calls return the cached CryptoKey without hitting Secrets Manager again.
 *
 * @returns {Promise<CryptoKey>} The imported RSA public key (CryptoKey).
 */

async function getKey() {
  
  if (!cachedPublicKey) {
    const pem = await getSecret(process.env.PUBLIC_KEY_SECRET_NAME);
    // jose v5 is ESM-only; dynamic import() is required from CommonJS.
    const { importSPKI } = await import('jose');
    cachedPublicKey = await importSPKI(pem, 'RSA-OAEP-256');
  
  }
  return cachedPublicKey;
}

/**
 * Returns true only when `payload` is a plain, non-null, non-array object
 * that contains at least one own key.
 *
 * @param {*} payload
 * @returns {boolean}
 */
function isValidPayload(payload) {
  return (
    payload !== null &&
    typeof payload === 'object' &&
    !Array.isArray(payload) &&
    Object.keys(payload).length > 0
  );
}

/**
 * Returns true when the serialized byte length of `payload` exceeds 256 KB.
 *
 * @param {object} payload
 * @returns {boolean}
 */
function isOversized(payload) {
  return Buffer.byteLength(JSON.stringify(payload)) > 256 * 1024;
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
 * AWS Lambda entry point for the jose-encryptor function.
 *
 * Expected event shape: { payload: { ...} }
 *
 * Validates the payload, retrieves (and caches) the RSA public key from
 * Secrets Manager, encrypts the payload as a JWE Compact Serialization token,
 * and returns it in the response body.
 *
 * @param {object} event - Lambda invocation event.
 * @returns {Promise<object>} API Gateway proxy-compatible response.
 */
exports.handler = async (event) => {
  // 1. Validate presence of payload field.
  // Treat a missing key or an explicit undefined value as "missing".
  if (!('payload' in event) || event.payload === undefined) {
    return errorResponse(400, 'Missing required field: payload');
  }

  // 2. Validate payload type and non-emptiness.
  if (!isValidPayload(event.payload)) {
    return errorResponse(400, 'Invalid payload: must be a non-empty valid JSON object');
  }

  // 3. Validate payload size.
  if (isOversized(event.payload)) {
    return errorResponse(400, 'Payload too large: maximum size is 256KB');
  }

  // 4. Retrieve (and cache) the public key.
  let publicKey;
  try {
    publicKey = await getKey();
  } catch (e) {
    return errorResponse(500, 'Failed to retrieve encryption key');
  }

  // 5. Encrypt the payload.
  try {
    const token = await encryptPayload(event.payload, publicKey);
    return successResponse({ token });
  } catch (e) {
    return errorResponse(500, 'Encryption failed');
  }
};

// Exported for unit testing.
exports._resetCache = () => { cachedPublicKey = null; };
exports._isValidPayload = isValidPayload;
exports._isOversized = isOversized;
