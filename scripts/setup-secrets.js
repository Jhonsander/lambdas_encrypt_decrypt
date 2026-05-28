'use strict';

const fs = require('fs');
const path = require('path');
const {
  SecretsManagerClient,
  CreateSecretCommand,
  UpdateSecretValueCommand,
} = require('@aws-sdk/client-secrets-manager');

/**
 * Parse CLI arguments of the form --key value into an object.
 * @param {string[]} argv - process.argv slice (from index 2)
 * @returns {Object} parsed key/value pairs
 */
function parseArgs(argv) {
  const result = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--') && i + 1 < argv.length) {
      const key = argv[i].slice(2); // strip leading '--'
      result[key] = argv[i + 1];
      i++; // skip value
    }
  }
  return result;
}

/**
 * Resolve configuration from CLI args, environment variables, and defaults.
 * @param {string[]} [argv] - optional argv override (defaults to process.argv.slice(2))
 * @returns {{ publicKeyName: string, privateKeyName: string, region: string }}
 */
function resolveConfig(argv) {
  const args = parseArgs(argv !== undefined ? argv : process.argv.slice(2));

  const publicKeyName =
    args['public-key-name'] ||
    process.env.PUBLIC_KEY_SECRET_NAME ||
    'jwe/public-key';

  const privateKeyName =
    args['private-key-name'] ||
    process.env.PRIVATE_KEY_SECRET_NAME ||
    'jwe/private-key';

  const region =
    args['region'] ||
    process.env.AWS_REGION ||
    'us-east-1';

  return { publicKeyName, privateKeyName, region };
}

/**
 * Read a PEM file from disk.
 * Exits the process immediately with code 1 if the file cannot be read.
 *
 * @param {string} filePath - absolute path to the PEM file
 * @returns {string} file contents as a UTF-8 string
 */
function readPemFile(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    console.error(
      `Error: could not read PEM file at "${filePath}": ${err.message}`
    );
    process.exit(1);
  }
}

/**
 * Create or update a secret in AWS Secrets Manager.
 * - Tries CreateSecretCommand first.
 * - If the secret already exists (ResourceExistsException), falls back to
 *   UpdateSecretValueCommand.
 * - Any other error is re-thrown to the caller.
 *
 * @param {SecretsManagerClient} client
 * @param {string} secretName
 * @param {string} secretValue
 * @returns {Promise<{ ARN: string }>} the response from the create/update call
 */
async function upsertSecret(client, secretName, secretValue) {
  try {
    const response = await client.send(
      new CreateSecretCommand({
        Name: secretName,
        SecretString: secretValue,
      })
    );
    return response;
  } catch (err) {
    if (err.name === 'ResourceExistsException') {
      const response = await client.send(
        new UpdateSecretValueCommand({
          SecretId: secretName,
          SecretString: secretValue,
        })
      );
      return response;
    }
    throw err;
  }
}

/**
 * Main entry point: reads both PEM files and upserts them into Secrets Manager.
 */
async function main() {
  const { publicKeyName, privateKeyName, region } = resolveConfig();

  const publicKeyPath = path.resolve(__dirname, '..', 'public-key.pem');
  const privateKeyPath = path.resolve(__dirname, '..', 'private-key.pem');

  // Read PEM files — exits immediately on failure (requirement 3.1, 3.2)
  const publicKeyPem = readPemFile(publicKeyPath);
  const privateKeyPem = readPemFile(privateKeyPath);

  const client = new SecretsManagerClient({ region });

  try {
    const pubResult = await upsertSecret(client, publicKeyName, publicKeyPem);
    console.log(`Public key secret ARN: ${pubResult.ARN}`);

    const privResult = await upsertSecret(client, privateKeyName, privateKeyPem);
    console.log(`Private key secret ARN: ${privResult.ARN}`);
  } catch (err) {
    console.error(`Error upserting secret: ${err.message}`);
    process.exit(1);
  }
}

module.exports = { readPemFile, upsertSecret, main, resolveConfig };

// Only run when executed directly (not when required in tests)
if (require.main === module) {
  main();
}
