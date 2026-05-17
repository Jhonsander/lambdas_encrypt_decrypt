'use strict';

/**
 * Decrypts a JWE Compact Serialization token using an RSA private key.
 *
 * Uses dynamic import() because jose v5 is ESM-only while this package
 * runs in a CommonJS Lambda environment (no "type": "module" in package.json).
 *
 * Error mapping (jose error codes → domain errors):
 *   ERR_JWE_DECRYPTION_FAILED → key mismatch or AES-GCM integrity failure
 *   ERR_JWE_INVALID           → malformed / structurally invalid token
 *   anything else             → re-thrown as-is for the handler to catch
 *
 * Validates: Requirements 3.1, 3.2, 3.3
 *
 * @param {string} token                      - JWE Compact Serialization string (5 dot-separated parts)
 * @param {string|CryptoKey} privateKeyOrPem  - RSA private key: either a PEM string (PKCS8
 *                                              format) or an already-imported CryptoKey.
 *                                              Passing a CryptoKey avoids a redundant import
 *                                              when the handler caches the key in memory.
 * @returns {Promise<object>}                 - Decrypted payload as a parsed JSON object
 * @throws {Error}                            - With code ERR_JWE_DECRYPTION_FAILED or ERR_JWE_INVALID
 */
async function decryptToken(token, privateKeyOrPem) {
  // Dynamic import required: jose v5 is ESM-only
  const { compactDecrypt, importPKCS8 } = await import('jose');

  // Accept either a pre-imported CryptoKey (from the handler cache) or a PEM string.
  const privateKey =
    typeof privateKeyOrPem === 'string'
      ? await importPKCS8(privateKeyOrPem, 'RSA-OAEP-256')
      : privateKeyOrPem;

  let plaintext;
  try {
    const result = await compactDecrypt(token, privateKey);
    plaintext = result.plaintext;
  } catch (err) {
    // ERR_JWE_DECRYPTION_FAILED covers both key mismatch and AES-GCM tag failure.
    // ERR_JWE_INVALID covers structurally malformed tokens.
    // Both are re-thrown with their original jose error code so the handler
    // can map them to the correct HTTP status (422 vs 400).
    if (
      err.code === 'ERR_JWE_DECRYPTION_FAILED' ||
      err.code === 'ERR_JWE_INVALID'
    ) {
      throw err;
    }
    // Unexpected errors are propagated unchanged
    throw err;
  }

  // Decode the raw bytes to a UTF-8 string and parse as JSON
  const decoded = new TextDecoder().decode(plaintext);
  return JSON.parse(decoded);
}

module.exports = { decryptToken };
