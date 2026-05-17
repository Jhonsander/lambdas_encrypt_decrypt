const { SecretsManagerClient, GetSecretValueCommand } = require('@aws-sdk/client-secrets-manager');

const client = new SecretsManagerClient({ region: process.env.AWS_REGION });

/**
 * Retrieves a secret string from AWS Secrets Manager.
 * Errors are propagated to the caller (handler is responsible for catching them).
 *
 * @param {string} secretName - The name or ARN of the secret to retrieve
 * @returns {Promise<string>} The secret value as a string (PEM format for RSA keys)
 */

async function getSecret(secretName) {
  const command = new GetSecretValueCommand({ SecretId: secretName });
  const response = await client.send(command);
  return response.SecretString;
}

module.exports = { getSecret };
