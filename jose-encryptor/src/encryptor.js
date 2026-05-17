'use strict';

/**
 * Encrypts a JSON payload using JWE Compact Serialization.
 *
 * Algorithms:
 *   - Key encryption : RSA-OAEP-256
 *   - Content encryption: AES-256-GCM
 *
 * @param {object} payload                    - The JSON object to encrypt.
 * @param {string|CryptoKey} publicKeyOrPem   - RSA public key: either a PEM string (SPKI
 *                                              format) or an already-imported CryptoKey.
 *                                              Passing a CryptoKey avoids a redundant import
 *                                              when the handler caches the key in memory.
 * @returns {Promise<string>}                 - The JWE Compact Serialization token (5 dot-separated parts).
 */

async function encryptPayload(payload, publicKeyOrPem) {
  // jose v5 is ESM-only; use dynamic import() from a CommonJS module.
  const { importSPKI, CompactEncrypt } = await import('jose');

  // Accept either a pre-imported CryptoKey (from the handler cache) or a PEM string.
  const publicKey =
    typeof publicKeyOrPem === 'string'
      ? await importSPKI(publicKeyOrPem, 'RSA-OAEP-256')
      : publicKeyOrPem;

  // Serialize the payload to a Uint8Array (UTF-8 encoded JSON string).
  const plaintext = new TextEncoder().encode(JSON.stringify(payload));

  // Build and execute the JWE encryption.
  const token = await new CompactEncrypt(plaintext)
    .setProtectedHeader({ alg: 'RSA-OAEP-256', enc: 'A256GCM' })
    .encrypt(publicKey);

  return token;
}

module.exports = { encryptPayload };
