'use strict';

const {
  LambdaClient,
  InvokeCommand,
} = require('@aws-sdk/client-lambda');
const {
  CloudFormationClient,
  DescribeStacksCommand,
} = require('@aws-sdk/client-cloudformation');

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
 * @returns {{ stackName: string, region: string }}
 */
function resolveConfig(argv) {
  const args = parseArgs(argv !== undefined ? argv : process.argv.slice(2));

  const stackName =
    args['stack-name'] ||
    process.env.STACK_NAME ||
    'jwe-lambda-functions';

  const region =
    args['region'] ||
    process.env.AWS_REGION ||
    'us-east-1';

  return { stackName, region };
}

/**
 * Derive Lambda function names from the stack name, optionally consulting
 * CloudFormation outputs for the exact ARNs.
 *
 * First tries to get the ARNs from CloudFormation stack outputs
 * (JoseEncryptorFunctionArn, JoseDecryptorFunctionArn). If the stack is not
 * found or the outputs are missing, falls back to the conventional naming
 * pattern `${stackName}-JoseEncryptorFunction` / `${stackName}-JoseDecryptorFunction`.
 *
 * @param {CloudFormationClient} cfnClient
 * @param {string} stackName
 * @returns {Promise<{ encryptorName: string, decryptorName: string }>}
 */
async function getFunctionNames(cfnClient, stackName) {
  try {
    const response = await cfnClient.send(
      new DescribeStacksCommand({ StackName: stackName })
    );

    const stack = response.Stacks && response.Stacks[0];
    if (stack && stack.Outputs && stack.Outputs.length > 0) {
      const encryptorOutput = stack.Outputs.find(
        (o) => o.OutputKey === 'JoseEncryptorFunctionArn'
      );
      const decryptorOutput = stack.Outputs.find(
        (o) => o.OutputKey === 'JoseDecryptorFunctionArn'
      );

      if (encryptorOutput && decryptorOutput) {
        return {
          encryptorName: encryptorOutput.OutputValue,
          decryptorName: decryptorOutput.OutputValue,
        };
      }
    }
  } catch (err) {
    // If the stack doesn't exist, the SDK throws a ValidationError or similar
    if (
      err.name === 'ValidationError' ||
      err.message.includes('does not exist')
    ) {
      console.error(
        `Error: CloudFormation stack "${stackName}" not found. ` +
          'Make sure the stack is deployed before running the integration test.'
      );
      process.exit(1);
    }
    // For other errors (e.g. permissions), fall through to the naming convention
  }

  // Fallback: derive names from the stack name using the SAM naming convention
  return {
    encryptorName: `${stackName}-JoseEncryptorFunction`,
    decryptorName: `${stackName}-JoseDecryptorFunction`,
  };
}

/**
 * Invoke a Lambda function and return the parsed response body.
 *
 * Exits the process with code 1 if:
 * - The invocation itself returns a FunctionError
 * - The parsed response body has a statusCode other than 200
 *
 * @param {LambdaClient} client
 * @param {string} functionName - function name or ARN
 * @param {Object} payload - JSON-serialisable event payload
 * @returns {Promise<Object>} parsed body from the Lambda response
 */
async function invokeLambda(client, functionName, payload) {
  let response;
  try {
    response = await client.send(
      new InvokeCommand({
        FunctionName: functionName,
        Payload: Buffer.from(JSON.stringify(payload)),
      })
    );
  } catch (err) {
    console.error(
      `Error invoking Lambda "${functionName}": ${err.message}`
    );
    process.exit(1);
  }

  // FunctionError is set when the Lambda itself threw an unhandled exception
  if (response.FunctionError) {
    const errorPayload = response.Payload
      ? Buffer.from(response.Payload).toString('utf8')
      : '(no payload)';
    console.error(
      `Lambda "${functionName}" returned a FunctionError (${response.FunctionError}):\n${errorPayload}`
    );
    process.exit(1);
  }

  // Parse the outer Lambda response payload
  const rawPayload = Buffer.from(response.Payload).toString('utf8');
  let lambdaResponse;
  try {
    lambdaResponse = JSON.parse(rawPayload);
  } catch (err) {
    console.error(
      `Error parsing Lambda response from "${functionName}": ${err.message}\nRaw payload: ${rawPayload}`
    );
    process.exit(1);
  }

  // Verify HTTP-style statusCode
  if (lambdaResponse.statusCode !== 200) {
    console.error(
      `Lambda "${functionName}" returned statusCode ${lambdaResponse.statusCode}.\n` +
        `Response body: ${lambdaResponse.body}`
    );
    process.exit(1);
  }

  // Parse the body (Lambdas return body as a JSON string)
  let body;
  try {
    body = JSON.parse(lambdaResponse.body);
  } catch (err) {
    console.error(
      `Error parsing body from Lambda "${functionName}": ${err.message}\nRaw body: ${lambdaResponse.body}`
    );
    process.exit(1);
  }

  return body;
}

/**
 * Verify that a string is a valid JWE Compact Serialization token.
 * A valid JWE token has exactly 5 parts separated by dots.
 *
 * @param {string} token
 * @returns {boolean}
 */
function isValidJWEToken(token) {
  if (typeof token !== 'string') return false;
  const parts = token.split('.');
  return parts.length === 5;
}

/**
 * Main entry point: runs the end-to-end integration test.
 *
 * 1. Invokes JoseEncryptorFunction with a test payload.
 * 2. Validates the returned JWE token format.
 * 3. Invokes JoseDecryptorFunction with the token.
 * 4. Verifies the decrypted payload matches the original.
 * 5. Prints a success message.
 */
async function main() {
  const { stackName, region } = resolveConfig();

  const cfnClient = new CloudFormationClient({ region });
  const lambdaClient = new LambdaClient({ region });

  // Resolve function names (from CloudFormation outputs or naming convention)
  const { encryptorName, decryptorName } = await getFunctionNames(
    cfnClient,
    stackName
  );

  console.log(`Stack:      ${stackName}`);
  console.log(`Region:     ${region}`);
  console.log(`Encryptor:  ${encryptorName}`);
  console.log(`Decryptor:  ${decryptorName}`);
  console.log('');

  // Step 1: Invoke the encryptor with a test payload
  const testPayload = { test: 'integration', timestamp: Date.now() };
  console.log('Step 1: Invoking JoseEncryptorFunction...');
  const encryptorBody = await invokeLambda(lambdaClient, encryptorName, {
    payload: testPayload,
  });

  // Step 2: Validate the JWE token format
  const token = encryptorBody.token;
  if (!isValidJWEToken(token)) {
    console.error(
      `Error: JoseEncryptorFunction returned an invalid JWE token format.\n` +
        `Expected a string with exactly 5 dot-separated parts.\n` +
        `Received: ${JSON.stringify(token)}`
    );
    process.exit(1);
  }
  console.log(`  ✓ Received valid JWE token (${token.split('.').length} parts)`);

  // Step 3: Invoke the decryptor with the token
  console.log('Step 2: Invoking JoseDecryptorFunction...');
  const decryptorBody = await invokeLambda(lambdaClient, decryptorName, {
    token,
  });

  // Step 4: Verify the decrypted payload matches the original
  const decryptedPayload = decryptorBody.payload;
  if (!decryptedPayload || decryptedPayload.test !== testPayload.test) {
    console.error(
      `Error: Decrypted payload does not match the original.\n` +
        `Original:  ${JSON.stringify(testPayload)}\n` +
        `Decrypted: ${JSON.stringify(decryptedPayload)}`
    );
    process.exit(1);
  }
  console.log(`  ✓ Decrypted payload matches original`);

  // Step 5: Success
  console.log('');
  console.log(
    '✅ Integration test passed: encrypt → decrypt flow works correctly.'
  );
}

module.exports = {
  parseArgs,
  resolveConfig,
  getFunctionNames,
  invokeLambda,
  isValidJWEToken,
  main,
};

// Only run when executed directly (not when required in tests)
if (require.main === module) {
  main().catch((err) => {
    console.error(`Unexpected error: ${err.message}`);
    process.exit(1);
  });
}
