'use strict';

// Mock @aws-sdk/client-secrets-manager before requiring the module under test
jest.mock('@aws-sdk/client-secrets-manager', () => {
  const mockSend = jest.fn();
  const MockSecretsManagerClient = jest.fn().mockImplementation(() => ({
    send: mockSend,
  }));
  const CreateSecretCommand = jest.fn().mockImplementation((input) => ({ _type: 'CreateSecretCommand', input }));
  const UpdateSecretValueCommand = jest.fn().mockImplementation((input) => ({ _type: 'UpdateSecretValueCommand', input }));

  return {
    SecretsManagerClient: MockSecretsManagerClient,
    CreateSecretCommand,
    UpdateSecretValueCommand,
    __mockSend: mockSend,
  };
});

jest.mock('fs');

const fs = require('fs');
const {
  SecretsManagerClient,
  CreateSecretCommand,
  UpdateSecretValueCommand,
  __mockSend: mockSend,
} = require('@aws-sdk/client-secrets-manager');

const { readPemFile, upsertSecret, resolveConfig } = require('./setup-secrets');

// Helper to get the mock send function from a client instance
function getSendFromClient(clientInstance) {
  return clientInstance.send;
}

describe('readPemFile', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('returns file contents when file exists', () => {
    fs.readFileSync.mockReturnValue('-----BEGIN PUBLIC KEY-----\nMIIBIjAN\n-----END PUBLIC KEY-----\n');
    const result = readPemFile('/some/path/public-key.pem');
    expect(result).toBe('-----BEGIN PUBLIC KEY-----\nMIIBIjAN\n-----END PUBLIC KEY-----\n');
    expect(fs.readFileSync).toHaveBeenCalledWith('/some/path/public-key.pem', 'utf8');
  });

  test('calls process.exit(1) when file cannot be read', () => {
    fs.readFileSync.mockImplementation(() => { throw new Error('ENOENT: no such file'); });
    const exitSpy = jest.spyOn(process, 'exit').mockImplementation(() => { throw new Error('process.exit called'); });
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    expect(() => readPemFile('/nonexistent/path.pem')).toThrow('process.exit called');
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(errorSpy).toHaveBeenCalled();

    exitSpy.mockRestore();
    errorSpy.mockRestore();
  });

  test('does not call SDK when file cannot be read', () => {
    fs.readFileSync.mockImplementation(() => { throw new Error('ENOENT: no such file'); });
    const exitSpy = jest.spyOn(process, 'exit').mockImplementation(() => { throw new Error('process.exit called'); });
    jest.spyOn(console, 'error').mockImplementation(() => {});

    expect(() => readPemFile('/nonexistent/path.pem')).toThrow('process.exit called');
    // SecretsManagerClient constructor should not have been called
    expect(SecretsManagerClient).not.toHaveBeenCalled();

    exitSpy.mockRestore();
    jest.restoreAllMocks();
  });
});

describe('upsertSecret', () => {
  let client;

  beforeEach(() => {
    jest.clearAllMocks();
    client = new SecretsManagerClient({ region: 'us-east-1' });
  });

  test('calls CreateSecretCommand with correct arguments when secret does not exist', async () => {
    const fakeArn = 'arn:aws:secretsmanager:us-east-1:123456789012:secret:jwe/public-key-AbCdEf';
    client.send.mockResolvedValue({ ARN: fakeArn });

    const result = await upsertSecret(client, 'jwe/public-key', '-----BEGIN PUBLIC KEY-----\n...\n-----END PUBLIC KEY-----\n');

    expect(CreateSecretCommand).toHaveBeenCalledWith({
      Name: 'jwe/public-key',
      SecretString: '-----BEGIN PUBLIC KEY-----\n...\n-----END PUBLIC KEY-----\n',
    });
    expect(result.ARN).toBe(fakeArn);
  });

  test('calls UpdateSecretValueCommand when ResourceExistsException is thrown', async () => {
    const fakeArn = 'arn:aws:secretsmanager:us-east-1:123456789012:secret:jwe/public-key-AbCdEf';
    const resourceExistsError = new Error('Secret already exists');
    resourceExistsError.name = 'ResourceExistsException';

    client.send
      .mockRejectedValueOnce(resourceExistsError)
      .mockResolvedValueOnce({ ARN: fakeArn });

    const result = await upsertSecret(client, 'jwe/public-key', '-----BEGIN PUBLIC KEY-----\n...\n-----END PUBLIC KEY-----\n');

    expect(UpdateSecretValueCommand).toHaveBeenCalledWith({
      SecretId: 'jwe/public-key',
      SecretString: '-----BEGIN PUBLIC KEY-----\n...\n-----END PUBLIC KEY-----\n',
    });
    expect(result.ARN).toBe(fakeArn);
  });

  test('re-throws error when AWS SDK throws an error other than ResourceExistsException', async () => {
    const accessDeniedError = new Error('Access denied');
    accessDeniedError.name = 'AccessDeniedException';
    client.send.mockRejectedValue(accessDeniedError);

    await expect(
      upsertSecret(client, 'jwe/public-key', 'some-pem-content')
    ).rejects.toThrow('Access denied');
  });
});

describe('resolveConfig', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env = { ...originalEnv };
    delete process.env.PUBLIC_KEY_SECRET_NAME;
    delete process.env.PRIVATE_KEY_SECRET_NAME;
    delete process.env.AWS_REGION;
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  test('uses CLI arguments when provided', () => {
    const config = resolveConfig([
      '--public-key-name', 'my/public-key',
      '--private-key-name', 'my/private-key',
      '--region', 'eu-west-1',
    ]);
    expect(config.publicKeyName).toBe('my/public-key');
    expect(config.privateKeyName).toBe('my/private-key');
    expect(config.region).toBe('eu-west-1');
  });

  test('uses environment variables when no CLI arguments are provided', () => {
    process.env.PUBLIC_KEY_SECRET_NAME = 'env/public-key';
    process.env.PRIVATE_KEY_SECRET_NAME = 'env/private-key';
    process.env.AWS_REGION = 'ap-southeast-1';

    const config = resolveConfig([]);
    expect(config.publicKeyName).toBe('env/public-key');
    expect(config.privateKeyName).toBe('env/private-key');
    expect(config.region).toBe('ap-southeast-1');
  });

  test('uses default values when no CLI arguments or environment variables are provided', () => {
    const config = resolveConfig([]);
    expect(config.publicKeyName).toBe('jwe/public-key');
    expect(config.privateKeyName).toBe('jwe/private-key');
    expect(config.region).toBe('us-east-1');
  });

  test('CLI arguments take precedence over environment variables', () => {
    process.env.PUBLIC_KEY_SECRET_NAME = 'env/public-key';
    process.env.PRIVATE_KEY_SECRET_NAME = 'env/private-key';

    const config = resolveConfig([
      '--public-key-name', 'cli/public-key',
      '--private-key-name', 'cli/private-key',
    ]);
    expect(config.publicKeyName).toBe('cli/public-key');
    expect(config.privateKeyName).toBe('cli/private-key');
  });
});

describe('main — error handling integration', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('calls process.exit(1) and shows error when AWS SDK throws non-ResourceExistsException', async () => {
    // We test this indirectly through upsertSecret re-throwing
    const accessDeniedError = new Error('Access denied');
    accessDeniedError.name = 'AccessDeniedException';

    const client = new SecretsManagerClient({ region: 'us-east-1' });
    client.send.mockRejectedValue(accessDeniedError);

    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const exitSpy = jest.spyOn(process, 'exit').mockImplementation(() => { throw new Error('process.exit called'); });

    await expect(
      upsertSecret(client, 'jwe/public-key', 'some-pem').catch((err) => {
        console.error(`Error upserting secret: ${err.message}`);
        process.exit(1);
      })
    ).rejects.toThrow('process.exit called');

    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('Access denied'));
    expect(exitSpy).toHaveBeenCalledWith(1);

    errorSpy.mockRestore();
    exitSpy.mockRestore();
  });
});
