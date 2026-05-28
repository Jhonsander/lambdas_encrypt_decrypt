# Implementation Plan: JWE Lambda Functions — Despliegue con AWS SAM

## Overview

Implementar la infraestructura como código y los scripts de automatización para desplegar las funciones Lambda `jose-encryptor` y `jose-decryptor` en AWS usando SAM. El código de las Lambdas ya existe; este plan cubre exclusivamente los artefactos de despliegue, gestión de secretos y verificación post-despliegue.

## Tasks

- [x] 1. Crear el archivo `template.yaml` SAM
  - Crear `template.yaml` en la raíz del proyecto con la sección `AWSTemplateFormatVersion`, `Transform: AWS::Serverless-2016-10-31` y `Description`.
  - Definir la sección `Parameters` con `PublicKeySecretName` (default: `jwe/public-key`), `PrivateKeySecretName` (default: `jwe/private-key`) y `Environment` (default: `dev`).
  - Definir la sección `Globals` con `Runtime: nodejs22.x`, `Timeout: 10` y `MemorySize: 256`.
  - Definir el recurso `JoseEncryptorFunction` con `CodeUri: jose-encryptor/`, `Handler: src/handler.handler`, variable de entorno `PUBLIC_KEY_SECRET_NAME` referenciando el parámetro, y política IAM inline con `secretsmanager:GetSecretValue` restringida al ARN del secreto de clave pública usando `!Sub`.
  - Definir el recurso `JoseDecryptorFunction` con `CodeUri: jose-decryptor/`, `Handler: src/handler.handler`, variable de entorno `PRIVATE_KEY_SECRET_NAME` referenciando el parámetro, y política IAM inline con `secretsmanager:GetSecretValue` restringida al ARN del secreto de clave privada usando `!Sub`.
  - Definir la sección `Outputs` con `JoseEncryptorFunctionArn` y `JoseDecryptorFunctionArn` usando `!GetAtt`.
  - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.6, 1.7, 2.1, 2.2, 2.5, 3.3, 6.1, 6.2, 6.3, 6.4_

  - [ ]* 1.1 Escribir tests de validación estática del template
    - Crear `scripts/validate-template.test.js` usando Jest.
    - Parsear `template.yaml` con la librería `js-yaml` y verificar: existencia de `JoseEncryptorFunction` y `JoseDecryptorFunction` con `Runtime: nodejs22.x`; handlers correctos; variables de entorno `PUBLIC_KEY_SECRET_NAME` y `PRIVATE_KEY_SECRET_NAME`; parámetros `PublicKeySecretName` y `PrivateKeySecretName`; `Timeout >= 10` y `MemorySize >= 256` para cada función; políticas IAM con acción `secretsmanager:GetSecretValue` y recursos distintos para cada función.
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.6, 1.7, 2.1, 2.2, 6.1, 6.2, 6.3, 6.4_

- [x] 2. Crear el archivo `samconfig.toml`
  - Crear `samconfig.toml` en la raíz del proyecto con la sección `[default.deploy.parameters]`.
  - Configurar: `stack_name = "jwe-lambda-functions"`, `region = "us-east-1"`, `confirm_changeset = true`, `capabilities = "CAPABILITY_IAM"`, `resolve_s3 = true`.
  - Agregar sección `[default.build.parameters]` con `cached = true` y `parallel = true`.
  - _Requirements: 4.4_

- [x] 3. Inicializar el proyecto de scripts y crear el Setup Script
  - Agregar dependencias al `scripts/package.json` existente: `@aws-sdk/client-secrets-manager ^3.0.0` y como devDependencies `jest ^29.0.0`.
  - Agregar script de test en `scripts/package.json`: `"test": "jest --runInBand"`.
  - Crear `scripts/setup-secrets.js` con la siguiente lógica:
    - Parsear argumentos de CLI (`--public-key-name`, `--private-key-name`, `--region`) con fallback a variables de entorno (`PUBLIC_KEY_SECRET_NAME`, `PRIVATE_KEY_SECRET_NAME`, `AWS_REGION`) y valores por defecto (`jwe/public-key`, `jwe/private-key`, `us-east-1`).
    - Función `readPemFile(filePath)`: leer archivo con `fs.readFileSync`; si falla, llamar `console.error` con mensaje descriptivo y `process.exit(1)` inmediatamente.
    - Función `upsertSecret(client, secretName, secretValue)`: intentar `CreateSecretCommand`; si lanza `ResourceExistsException`, llamar `UpdateSecretValueCommand`; si lanza cualquier otro error, relanzar.
    - Función `main()`: leer ambos archivos PEM desde la raíz del proyecto (usando `path.resolve(__dirname, '..', 'public-key.pem')` y `private-key.pem`), llamar `upsertSecret` para cada uno, mostrar ARN resultante con `console.log`, manejar errores con `console.error` + `process.exit(1)`.
  - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 3.6_

  - [x]* 3.1 Escribir unit tests para setup-secrets.js
    - Crear `scripts/setup-secrets.test.js` usando Jest con mocks de `@aws-sdk/client-secrets-manager` y `fs`.
    - Test: archivo PEM existe → `CreateSecretCommand` es llamado con el contenido correcto.
    - Test: archivo PEM no existe → `process.exit(1)` es llamado sin invocar el SDK.
    - Test: secreto ya existe (`ResourceExistsException`) → `UpdateSecretValueCommand` es llamado con el contenido correcto.
    - Test: error de AWS SDK distinto de `ResourceExistsException` → `process.exit(1)` es llamado y se muestra mensaje de error.
    - Test: argumentos de CLI presentes → se usan como nombres de secretos.
    - Test: sin argumentos de CLI pero con variables de entorno → se usan las variables de entorno.
    - Test: sin argumentos ni variables de entorno → se usan los valores por defecto.
    - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.6_

- [x] 4. Checkpoint — Validar template y tests del setup script
  - Ejecutar `sam validate --lint` y verificar que no hay errores.
  - Ejecutar `cd scripts && npm test` y verificar que todos los tests pasan.
  - Asegurarse de que todos los tests pasan; consultar al usuario si surgen dudas.

- [x] 5. Crear el Integration Test Script
  - Crear `scripts/integration-test.js` con la siguiente lógica:
    - Parsear argumentos de CLI (`--stack-name`, `--region`) con fallback a variables de entorno (`STACK_NAME`, `AWS_REGION`) y valores por defecto (`jwe-lambda-functions`, `us-east-1`).
    - Función `getFunctionNames(stackName)`: derivar nombres de funciones Lambda como `${stackName}-JoseEncryptorFunction` y `${stackName}-JoseDecryptorFunction`, o consultar los outputs de CloudFormation con `DescribeStacksCommand` para obtener los ARNs exactos.
    - Función `invokeLambda(client, functionName, payload)`: invocar Lambda con `InvokeCommand`, verificar que no hay `FunctionError`, parsear el body de la respuesta, verificar `statusCode == 200`; si falla, llamar `console.error` con detalles + `process.exit(1)`.
    - Función `isValidJWEToken(token)`: verificar que el token tiene exactamente 5 partes separadas por puntos.
    - Función `main()`:
      1. Invocar `JoseEncryptorFunction` con payload de prueba `{ payload: { test: "integration", timestamp: Date.now() } }`.
      2. Extraer `token` del body de la respuesta; si no tiene formato JWE válido, `console.error` + `process.exit(1)`.
      3. Invocar `JoseDecryptorFunction` con `{ token }`.
      4. Extraer `payload` del body de la respuesta; verificar que `payload.test === "integration"`.
      5. Mostrar mensaje de éxito con `console.log`.
  - _Requirements: 5.1, 5.2, 5.3, 5.4, 5.5, 5.6_

  - [x]* 5.1 Escribir unit tests para integration-test.js
    - Crear `scripts/integration-test.test.js` usando Jest con mocks de `@aws-sdk/client-lambda` y `@aws-sdk/client-cloudformation`.
    - Test: respuesta exitosa del encryptor con token JWE válido → invoca el decryptor con ese token.
    - Test: token con formato inválido (menos de 5 partes) → no invoca el decryptor, llama `process.exit(1)`.
    - Test: `statusCode != 200` en respuesta del encryptor → llama `process.exit(1)` con mensaje de error.
    - Test: `statusCode != 200` en respuesta del decryptor → llama `process.exit(1)` con mensaje de error.
    - Test: payload desencriptado equivalente al original → muestra mensaje de éxito.
    - Test: `FunctionError` en respuesta Lambda → llama `process.exit(1)`.
    - _Requirements: 5.1, 5.2, 5.3, 5.4, 5.6_

- [x] 6. Agregar dependencias de AWS SDK al scripts/package.json
  - Verificar que `scripts/package.json` incluye `@aws-sdk/client-lambda ^3.0.0` y `@aws-sdk/client-cloudformation ^3.0.0` como dependencias.
  - Ejecutar `npm install` en el directorio `scripts/` para instalar todas las dependencias.
  - _Requirements: 5.1, 5.2_

- [x] 7. Checkpoint final — Todos los tests pasan
  - Ejecutar `cd scripts && npm test` y verificar que todos los tests (validate-template, setup-secrets, integration-test) pasan.
  - Ejecutar `sam validate --lint` para confirmar que el template es válido.
  - Asegurarse de que todos los tests pasan; consultar al usuario si surgen dudas.

## Task Dependency Graph

```json
{
  "waves": [
    {
      "wave": 1,
      "tasks": ["1", "2"]
    },
    {
      "wave": 2,
      "tasks": ["3"]
    },
    {
      "wave": 3,
      "tasks": ["4"]
    },
    {
      "wave": 4,
      "tasks": ["5", "6"]
    },
    {
      "wave": 5,
      "tasks": ["7"]
    }
  ]
}
```

## Notes

- Las tareas marcadas con `*` son opcionales y pueden omitirse para un MVP mas rapido.
- El despliegue real en AWS requiere credenciales configuradas (`aws configure` o variables de entorno `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_REGION`).
- El orden de ejecucion en produccion es: `node scripts/setup-secrets.js` -> `sam build` -> `sam deploy` -> `node scripts/integration-test.js`.
- Los archivos `private-key.pem` y `public-key.pem` ya existen en la raiz del proyecto y no deben modificarse.
- El `samconfig.toml` usa `resolve_s3 = true` para que SAM gestione automaticamente el bucket S3 de artefactos.
- Cada tarea referencia los requisitos especificos del `requirements.md` para trazabilidad.
