'use strict';

/**
 * Unit tests for integration-test.js
 * Validates: Requirements 5.1, 5.2, 5.3, 5.4, 5.6
 */

// ─── Mocks ────────────────────────────────────────────────────────────────────

// We need to capture the mock send function so individual tests can configure it.
// The mock is set up before any require() calls.

const mockLambdaSend = jest.fn();
const mockCfnSend = jest.fn();

jest.mock('@aws-sdk/client-lambda', () => {
  const MockLambdaClient = jest.fn().mockImplementation(() => ({
    send: mockLambdaSend,
  }));
  const InvokeCommand = jest.fn().mockImplementation((input) => ({
    _type: 'InvokeCommand',
    input,
  }));
  return { LambdaClient: MockLambdaClient, InvokeCommand };
});

jest.mock('@aws-sdk/client-cloudformation', () => {
  const MockCloudFormationClient = jest.fn().mockImplementation(() => ({
    send: mockCfnSend,
  }));
  const DescribeStacksCommand = jest.fn().mockImplementation((input) => ({
    _type: 'DescribeStacksCommand',
    input,
  }));
  return {
    CloudFormationClient: MockCloudFormationClient,
    DescribeStacksCommand,
  };
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Build a Buffer-based Lambda response payload that mimics what the real Lambda
 * returns: an outer object with statusCode + body (JSON string).
 */
function makeLambdaPayload(statusCode, bodyObject) {
  const lambdaResponse = {
    statusCode,
    body: JSON.stringify(bodyObject),
  };
  return Buffer.from(JSON.stringify(lambdaResponse));
}

/**
 * Build a valid 5-part JWE compact serialisation token (fake but structurally
 * correct for isValidJWEToken purposes).
 */
const VALID_JWE_TOKEN = 'part1.part2.part3.part4.part5';

// ─── Imports (after mocks are registered) ─────────────────────────────────────

const {
  parseArgs,
  resolveConfig,
  getFunctionNames,
  invokeLambda,
  isValidJWEToken,
  main,
} = require('./integration-test');

const { LambdaClient, InvokeCommand } = require('@aws-sdk/client-lambda');
const {
  CloudFormationClient,
  DescribeStacksCommand,
} = require('@aws-sdk/client-cloudformation');

// ─── isValidJWEToken ──────────────────────────────────────────────────────────

describe('isValidJWEToken', () => {
  test('returns true for a token with exactly 5 dot-separated parts', () => {
    expect(isValidJWEToken('a.b.c.d.e')).toBe(true);
  });

  test('returns false for a token with fewer than 5 parts', () => {
    expect(isValidJWEToken('a.b.c.d')).toBe(false);
  });

  test('returns false for a token with more than 5 parts', () => {
    expect(isValidJWEToken('a.b.c.d.e.f')).toBe(false);
  });

  test('returns false for an empty string', () => {
    expect(isValidJWEToken('')).toBe(false);
  });

  test('returns false for a non-string value', () => {
    expect(isValidJWEToken(null)).toBe(false);
    expect(isValidJWEToken(undefined)).toBe(false);
    expect(isValidJWEToken(12345)).toBe(false);
  });
});

// ─── parseArgs ────────────────────────────────────────────────────────────────

describe('parseArgs', () => {
  test('parses --key value pairs correctly', () => {
    const result = parseArgs(['--stack-name', 'my-stack', '--region', 'eu-west-1']);
    expect(result['stack-name']).toBe('my-stack');
    expect(result['region']).toBe('eu-west-1');
  });

  test('returns empty object for empty argv', () => {
    expect(parseArgs([])).toEqual({});
  });
});

// ─── resolveConfig ────────────────────────────────────────────────────────────

describe('resolveConfig', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    delete process.env.STACK_NAME;
    delete process.env.AWS_REGION;
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  test('uses CLI arguments when provided', () => {
    const config = resolveConfig(['--stack-name', 'cli-stack', '--region', 'ap-southeast-1']);
    expect(config.stackName).toBe('cli-stack');
    expect(config.region).toBe('ap-southeast-1');
  });

  test('uses environment variables when no CLI arguments are provided', () => {
    process.env.STACK_NAME = 'env-stack';
    process.env.AWS_REGION = 'eu-central-1';
    const config = resolveConfig([]);
    expect(config.stackName).toBe('env-stack');
    expect(config.region).toBe('eu-central-1');
  });

  test('uses default values when neither CLI args nor env vars are set', () => {
    const config = resolveConfig([]);
    expect(config.stackName).toBe('jwe-lambda-functions');
    expect(config.region).toBe('us-east-1');
  });
});

// ─── getFunctionNames ─────────────────────────────────────────────────────────

describe('getFunctionNames', () => {
  let cfnClient;

  beforeEach(() => {
    jest.clearAllMocks();
    cfnClient = new CloudFormationClient({ region: 'us-east-1' });
  });

  test('returns ARNs from CloudFormation outputs when available', async () => {
    mockCfnSend.mockResolvedValue({
      Stacks: [
        {
          Outputs: [
            { OutputKey: 'JoseEncryptorFunctionArn', OutputValue: 'arn:aws:lambda:us-east-1:123:function:encryptor' },
            { OutputKey: 'JoseDecryptorFunctionArn', OutputValue: 'arn:aws:lambda:us-east-1:123:function:decryptor' },
          ],
        },
      ],
    });

    const result = await getFunctionNames(cfnClient, 'my-stack');
    expect(result.encryptorName).toBe('arn:aws:lambda:us-east-1:123:function:encryptor');
    expect(result.decryptorName).toBe('arn:aws:lambda:us-east-1:123:function:decryptor');
  });

  test('falls back to naming convention when CloudFormation outputs are missing', async () => {
    mockCfnSend.mockResolvedValue({ Stacks: [{ Outputs: [] }] });

    const result = await getFunctionNames(cfnClient, 'my-stack');
    expect(result.encryptorName).toBe('my-stack-JoseEncryptorFunction');
    expect(result.decryptorName).toBe('my-stack-JoseDecryptorFunction');
  });

  test('calls process.exit(1) when the CloudFormation stack does not exist', async () => {
    const validationError = new Error('Stack my-stack does not exist');
    validationError.name = 'ValidationError';
    mockCfnSend.mockRejectedValue(validationError);

    const exitSpy = jest.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('process.exit called');
    });
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    await expect(getFunctionNames(cfnClient, 'my-stack')).rejects.toThrow('process.exit called');
    expect(exitSpy).toHaveBeenCalledWith(1);

    exitSpy.mockRestore();
    errorSpy.mockRestore();
  });
});

// ─── invokeLambda ─────────────────────────────────────────────────────────────

describe('invokeLambda', () => {
  let lambdaClient;

  beforeEach(() => {
    jest.clearAllMocks();
    lambdaClient = new LambdaClient({ region: 'us-east-1' });
  });

  test('returns parsed body on a successful 200 response', async () => {
    mockLambdaSend.mockResolvedValue({
      Payload: makeLambdaPayload(200, { token: VALID_JWE_TOKEN }),
    });

    const result = await invokeLambda(lambdaClient, 'my-function', { payload: { test: 'data' } });
    expect(result.token).toBe(VALID_JWE_TOKEN);
  });

  test('calls process.exit(1) when statusCode is not 200', async () => {
    mockLambdaSend.mockResolvedValue({
      Payload: makeLambdaPayload(500, { error: 'Internal Server Error' }),
    });

    const exitSpy = jest.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('process.exit called');
    });
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    await expect(invokeLambda(lambdaClient, 'my-function', {})).rejects.toThrow('process.exit called');
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('500'));

    exitSpy.mockRestore();
    errorSpy.mockRestore();
  });

  test('calls process.exit(1) when FunctionError is present', async () => {
    mockLambdaSend.mockResolvedValue({
      FunctionError: 'Unhandled',
      Payload: Buffer.from(JSON.stringify({ errorMessage: 'Runtime error', errorType: 'Error' })),
    });

    const exitSpy = jest.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('process.exit called');
    });
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    await expect(invokeLambda(lambdaClient, 'my-function', {})).rejects.toThrow('process.exit called');
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('FunctionError'));

    exitSpy.mockRestore();
    errorSpy.mockRestore();
  });

  test('calls process.exit(1) when the SDK itself throws', async () => {
    mockLambdaSend.mockRejectedValue(new Error('Network error'));

    const exitSpy = jest.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('process.exit called');
    });
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    await expect(invokeLambda(lambdaClient, 'my-function', {})).rejects.toThrow('process.exit called');
    expect(exitSpy).toHaveBeenCalledWith(1);

    exitSpy.mockRestore();
    errorSpy.mockRestore();
  });
});

// ─── main ─────────────────────────────────────────────────────────────────────

describe('main', () => {
  let exitSpy;
  let errorSpy;
  let logSpy;

  beforeEach(() => {
    jest.clearAllMocks();

    // Suppress console output during tests
    logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    // Default: CloudFormation returns naming-convention fallback (empty outputs)
    mockCfnSend.mockResolvedValue({ Stacks: [{ Outputs: [] }] });
  });

  afterEach(() => {
    logSpy.mockRestore();
    errorSpy.mockRestore();
    if (exitSpy) {
      exitSpy.mockRestore();
      exitSpy = null;
    }
  });

  test('successful flow: encryptor returns valid JWE token → decryptor is invoked → success message shown', async () => {
    // Encryptor response: valid JWE token
    mockLambdaSend
      .mockResolvedValueOnce({
        Payload: makeLambdaPayload(200, { token: VALID_JWE_TOKEN }),
      })
      // Decryptor response: decrypted payload matches original
      .mockResolvedValueOnce({
        Payload: makeLambdaPayload(200, { payload: { test: 'integration', timestamp: 12345 } }),
      });

    await main();

    // Lambda was called twice (encryptor + decryptor)
    expect(mockLambdaSend).toHaveBeenCalledTimes(2);

    // The second call (decryptor) should have received the token
    const decryptorCall = mockLambdaSend.mock.calls[1][0];
    const decryptorPayload = JSON.parse(Buffer.from(decryptorCall.input.Payload).toString('utf8'));
    expect(decryptorPayload.token).toBe(VALID_JWE_TOKEN);

    // Success message should be logged
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Integration test passed'));
  });

  test('invalid JWE token (fewer than 5 parts) → does not invoke decryptor, calls process.exit(1)', async () => {
    exitSpy = jest.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('process.exit called');
    });

    // Encryptor returns a token with only 3 parts
    mockLambdaSend.mockResolvedValueOnce({
      Payload: makeLambdaPayload(200, { token: 'only.three.parts' }),
    });

    await expect(main()).rejects.toThrow('process.exit called');

    // Decryptor must NOT have been called
    expect(mockLambdaSend).toHaveBeenCalledTimes(1);
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('invalid JWE token'));
  });

  test('encryptor returns statusCode != 200 → calls process.exit(1)', async () => {
    exitSpy = jest.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('process.exit called');
    });

    mockLambdaSend.mockResolvedValueOnce({
      Payload: makeLambdaPayload(400, { error: 'Bad Request' }),
    });

    await expect(main()).rejects.toThrow('process.exit called');
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('400'));
  });

  test('decryptor returns statusCode != 200 → calls process.exit(1)', async () => {
    exitSpy = jest.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('process.exit called');
    });

    mockLambdaSend
      .mockResolvedValueOnce({
        Payload: makeLambdaPayload(200, { token: VALID_JWE_TOKEN }),
      })
      .mockResolvedValueOnce({
        Payload: makeLambdaPayload(500, { error: 'Decryption failed' }),
      });

    await expect(main()).rejects.toThrow('process.exit called');
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('500'));
  });

  test('decrypted payload matches original → shows success message', async () => {
    mockLambdaSend
      .mockResolvedValueOnce({
        Payload: makeLambdaPayload(200, { token: VALID_JWE_TOKEN }),
      })
      .mockResolvedValueOnce({
        Payload: makeLambdaPayload(200, { payload: { test: 'integration', timestamp: 99999 } }),
      });

    await main();

    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Integration test passed'));
  });

  test('FunctionError in encryptor response → calls process.exit(1)', async () => {
    exitSpy = jest.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('process.exit called');
    });

    mockLambdaSend.mockResolvedValueOnce({
      FunctionError: 'Unhandled',
      Payload: Buffer.from(JSON.stringify({ errorMessage: 'Runtime crashed', errorType: 'Error' })),
    });

    await expect(main()).rejects.toThrow('process.exit called');
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('FunctionError'));
  });

  test('FunctionError in decryptor response → calls process.exit(1)', async () => {
    exitSpy = jest.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('process.exit called');
    });

    mockLambdaSend
      .mockResolvedValueOnce({
        Payload: makeLambdaPayload(200, { token: VALID_JWE_TOKEN }),
      })
      .mockResolvedValueOnce({
        FunctionError: 'Unhandled',
        Payload: Buffer.from(JSON.stringify({ errorMessage: 'Decryptor crashed', errorType: 'Error' })),
      });

    await expect(main()).rejects.toThrow('process.exit called');
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('FunctionError'));
  });
});
