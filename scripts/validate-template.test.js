'use strict';

/**
 * Static validation tests for template.yaml
 * Validates: Requirements 1.1, 1.2, 1.3, 1.4, 1.6, 1.7, 2.1, 2.2, 6.1, 6.2, 6.3, 6.4
 */

const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

const TEMPLATE_PATH = path.resolve(__dirname, '..', 'template.yaml');

// CloudFormation uses custom YAML tags like !Ref, !Sub, !GetAtt, !If, etc.
// js-yaml v3 doesn't know these by default, so we register them as passthrough types.
const CF_TAGS = ['Ref', 'Sub', 'GetAtt', 'If', 'Select', 'Join', 'Split', 'FindInMap',
  'Base64', 'Condition', 'And', 'Or', 'Not', 'Equals', 'ImportValue', 'Transform',
  'ValueOf', 'ValueOfAll', 'Cidr'];

// For each tag, create scalar, sequence, and mapping variants
const cfTypes = [];
for (const tag of CF_TAGS) {
  cfTypes.push(new yaml.Type(`!${tag}`, {
    kind: 'scalar',
    construct: (data) => ({ [`Fn::${tag}`]: data }),
  }));
  cfTypes.push(new yaml.Type(`!${tag}`, {
    kind: 'sequence',
    construct: (data) => ({ [`Fn::${tag}`]: data }),
  }));
  cfTypes.push(new yaml.Type(`!${tag}`, {
    kind: 'mapping',
    construct: (data) => ({ [`Fn::${tag}`]: data }),
  }));
}

// js-yaml v3 uses new yaml.Schema({ include, explicit })
const CF_SCHEMA = new yaml.Schema({
  include: [yaml.DEFAULT_SAFE_SCHEMA],
  explicit: cfTypes,
});

let template;

beforeAll(() => {
  const raw = fs.readFileSync(TEMPLATE_PATH, 'utf8');
  template = yaml.load(raw, { schema: CF_SCHEMA });
});

describe('template.yaml — Parameters', () => {
  test('defines PublicKeySecretName parameter', () => {
    expect(template.Parameters).toBeDefined();
    expect(template.Parameters.PublicKeySecretName).toBeDefined();
    expect(template.Parameters.PublicKeySecretName.Type).toBe('String');
    expect(template.Parameters.PublicKeySecretName.Default).toBe('jwe/public-key');
  });

  test('defines PrivateKeySecretName parameter', () => {
    expect(template.Parameters.PrivateKeySecretName).toBeDefined();
    expect(template.Parameters.PrivateKeySecretName.Type).toBe('String');
    expect(template.Parameters.PrivateKeySecretName.Default).toBe('jwe/private-key');
  });
});

describe('template.yaml — Globals', () => {
  test('sets Runtime to nodejs22.x globally', () => {
    expect(template.Globals).toBeDefined();
    expect(template.Globals.Function).toBeDefined();
    expect(template.Globals.Function.Runtime).toBe('nodejs22.x');
  });

  test('sets Timeout >= 10 globally', () => {
    expect(template.Globals.Function.Timeout).toBeGreaterThanOrEqual(10);
  });

  test('sets MemorySize >= 256 globally', () => {
    expect(template.Globals.Function.MemorySize).toBeGreaterThanOrEqual(256);
  });
});

describe('template.yaml — JoseEncryptorFunction', () => {
  let encryptor;

  beforeAll(() => {
    encryptor = template.Resources && template.Resources.JoseEncryptorFunction;
  });

  test('resource exists', () => {
    expect(encryptor).toBeDefined();
  });

  test('has correct CodeUri', () => {
    expect(encryptor.Properties.CodeUri).toBe('jose-encryptor/');
  });

  test('has correct Handler', () => {
    expect(encryptor.Properties.Handler).toBe('src/handler.handler');
  });

  test('has PUBLIC_KEY_SECRET_NAME environment variable', () => {
    const envVars = encryptor.Properties.Environment && encryptor.Properties.Environment.Variables;
    expect(envVars).toBeDefined();
    expect(envVars.PUBLIC_KEY_SECRET_NAME).toBeDefined();
  });

  test('has IAM policy with secretsmanager:GetSecretValue action', () => {
    const policies = encryptor.Properties.Policies;
    expect(policies).toBeDefined();
    expect(Array.isArray(policies)).toBe(true);

    // Find the policy statement that grants secretsmanager access
    const hasSecretsPolicy = policies.some((policy) => {
      if (policy && policy.Statement) {
        const statements = Array.isArray(policy.Statement) ? policy.Statement : [policy.Statement];
        return statements.some((stmt) => {
          const actions = Array.isArray(stmt.Action) ? stmt.Action : [stmt.Action];
          return actions.includes('secretsmanager:GetSecretValue');
        });
      }
      return false;
    });
    expect(hasSecretsPolicy).toBe(true);
  });

  test('IAM policy resource references PublicKeySecretName (not PrivateKeySecretName)', () => {
    const policies = encryptor.Properties.Policies;
    let resourceStr = null;

    for (const policy of policies) {
      if (policy && policy.Statement) {
        const statements = Array.isArray(policy.Statement) ? policy.Statement : [policy.Statement];
        for (const stmt of statements) {
          const actions = Array.isArray(stmt.Action) ? stmt.Action : [stmt.Action];
          if (actions.includes('secretsmanager:GetSecretValue')) {
            resourceStr = typeof stmt.Resource === 'string'
              ? stmt.Resource
              : JSON.stringify(stmt.Resource);
          }
        }
      }
    }

    expect(resourceStr).not.toBeNull();
    expect(resourceStr).toContain('PublicKeySecretName');
    expect(resourceStr).not.toContain('PrivateKeySecretName');
  });
});

describe('template.yaml — JoseDecryptorFunction', () => {
  let decryptor;

  beforeAll(() => {
    decryptor = template.Resources && template.Resources.JoseDecryptorFunction;
  });

  test('resource exists', () => {
    expect(decryptor).toBeDefined();
  });

  test('has correct CodeUri', () => {
    expect(decryptor.Properties.CodeUri).toBe('jose-decryptor/');
  });

  test('has correct Handler', () => {
    expect(decryptor.Properties.Handler).toBe('src/handler.handler');
  });

  test('has PRIVATE_KEY_SECRET_NAME environment variable', () => {
    const envVars = decryptor.Properties.Environment && decryptor.Properties.Environment.Variables;
    expect(envVars).toBeDefined();
    expect(envVars.PRIVATE_KEY_SECRET_NAME).toBeDefined();
  });

  test('has IAM policy with secretsmanager:GetSecretValue action', () => {
    const policies = decryptor.Properties.Policies;
    expect(policies).toBeDefined();
    expect(Array.isArray(policies)).toBe(true);

    const hasSecretsPolicy = policies.some((policy) => {
      if (policy && policy.Statement) {
        const statements = Array.isArray(policy.Statement) ? policy.Statement : [policy.Statement];
        return statements.some((stmt) => {
          const actions = Array.isArray(stmt.Action) ? stmt.Action : [stmt.Action];
          return actions.includes('secretsmanager:GetSecretValue');
        });
      }
      return false;
    });
    expect(hasSecretsPolicy).toBe(true);
  });

  test('IAM policy resource references PrivateKeySecretName (not PublicKeySecretName)', () => {
    const policies = decryptor.Properties.Policies;
    let resourceStr = null;

    for (const policy of policies) {
      if (policy && policy.Statement) {
        const statements = Array.isArray(policy.Statement) ? policy.Statement : [policy.Statement];
        for (const stmt of statements) {
          const actions = Array.isArray(stmt.Action) ? stmt.Action : [stmt.Action];
          if (actions.includes('secretsmanager:GetSecretValue')) {
            resourceStr = typeof stmt.Resource === 'string'
              ? stmt.Resource
              : JSON.stringify(stmt.Resource);
          }
        }
      }
    }

    expect(resourceStr).not.toBeNull();
    expect(resourceStr).toContain('PrivateKeySecretName');
    expect(resourceStr).not.toContain('PublicKeySecretName');
  });
});

describe('template.yaml — Outputs', () => {
  test('defines JoseEncryptorFunctionArn output', () => {
    expect(template.Outputs).toBeDefined();
    expect(template.Outputs.JoseEncryptorFunctionArn).toBeDefined();
    expect(template.Outputs.JoseEncryptorFunctionArn.Value).toBeDefined();
  });

  test('defines JoseDecryptorFunctionArn output', () => {
    expect(template.Outputs.JoseDecryptorFunctionArn).toBeDefined();
    expect(template.Outputs.JoseDecryptorFunctionArn.Value).toBeDefined();
  });
});

describe('template.yaml — IAM policies are distinct per function', () => {
  test('encryptor and decryptor policies reference different secrets', () => {
    const getSecretsResource = (functionResource) => {
      const policies = functionResource.Properties.Policies;
      for (const policy of policies) {
        if (policy && policy.Statement) {
          const statements = Array.isArray(policy.Statement) ? policy.Statement : [policy.Statement];
          for (const stmt of statements) {
            const actions = Array.isArray(stmt.Action) ? stmt.Action : [stmt.Action];
            if (actions.includes('secretsmanager:GetSecretValue')) {
              return typeof stmt.Resource === 'string'
                ? stmt.Resource
                : JSON.stringify(stmt.Resource);
            }
          }
        }
      }
      return null;
    };

    const encryptorResource = getSecretsResource(template.Resources.JoseEncryptorFunction);
    const decryptorResource = getSecretsResource(template.Resources.JoseDecryptorFunction);

    expect(encryptorResource).not.toBeNull();
    expect(decryptorResource).not.toBeNull();
    expect(encryptorResource).not.toBe(decryptorResource);
  });
});
