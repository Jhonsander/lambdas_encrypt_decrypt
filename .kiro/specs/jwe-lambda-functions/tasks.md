# Implementation Plan: jwe-lambda-functions

## Overview

Implementación incremental de dos funciones AWS Lambda (`jose-encryptor` y `jose-decryptor`) con cifrado JWE usando RSA-OAEP-256 + AES-256-GCM, un script CLI de generación de llaves, y una suite de pruebas unitarias y de propiedades con Jest y fast-check.

## Tasks

- [x] 1. Configurar estructura del repositorio y dependencias base
  - Crear los directorios `jose-encryptor/src/`, `jose-encryptor/tests/`, `jose-decryptor/src/`, `jose-decryptor/tests/`, y `scripts/`
  - Crear `jose-encryptor/package.json` con dependencias: `jose ^5.0.0`, `@aws-sdk/client-secrets-manager ^3.0.0`; devDependencies: `jest ^29.0.0`, `fast-check ^3.0.0`
  - Crear `jose-decryptor/package.json` con las mismas dependencias
  - Crear `scripts/package.json` con dependencias: `jose ^5.0.0`, `@aws-sdk/client-secrets-manager ^3.0.0`
  - Configurar `jest` en cada `package.json` con `testEnvironment: node` y script `"test": "jest --runInBand"`
  - _Requerimientos: 6.1, 6.2, 6.3_

- [x] 2. Implementar módulo compartido secretsManager.js
  - [x] 2.1 Implementar `jose-encryptor/src/secretsManager.js`
    - Instanciar `SecretsManagerClient` con `AWS_REGION` del entorno
    - Exportar función `async getSecret(secretName)` que ejecuta `GetSecretValueCommand` y retorna `SecretString`
    - Propagar errores sin capturarlos (el handler los maneja)
    - _Requerimientos: 2.4, 2.7_
  - [x] 2.2 Implementar `jose-decryptor/src/secretsManager.js`
    - Misma estructura que el módulo del encryptor pero para la lambda desencriptadora
    - _Requerimientos: 3.4, 3.7_

- [x] 3. Implementar módulo encryptor.js
  - [x] 3.1 Implementar `jose-encryptor/src/encryptor.js`
    - Exportar función `async encryptPayload(payload, publicKeyPem)`
    - Importar llave pública con `jose.importSPKI(pem, 'RSA-OAEP-256')`
    - Serializar payload a `Uint8Array` con `TextEncoder`
    - Construir y ejecutar `new CompactEncrypt(plaintext).setProtectedHeader({ alg: 'RSA-OAEP-256', enc: 'A256GCM' }).encrypt(publicKey)`
    - Retornar el token JWE como string
    - _Requerimientos: 2.1, 2.2, 2.3_

- [x] 4. Implementar módulo decryptor.js
  - [x] 4.1 Implementar `jose-decryptor/src/decryptor.js`
    - Exportar función `async decryptToken(token, privateKeyPem)`
    - Importar llave privada con `jose.importPKCS8(pem, 'RSA-OAEP-256')`
    - Ejecutar `compactDecrypt(token, privateKey)`
    - Decodificar plaintext con `TextDecoder` y parsear como JSON
    - Propagar errores diferenciados: `ERR_JWE_DECRYPTION_FAILED` para key mismatch/integridad, `ERR_JWE_INVALID` para formato inválido
    - _Requerimientos: 3.1, 3.2, 3.3_

- [x] 5. Checkpoint — Verificar módulos base
  - Asegurarse de que todos los módulos (`secretsManager.js`, `encryptor.js`, `decryptor.js`) se importan sin errores de sintaxis. Consultar al usuario si surgen dudas.

- [x] 6. Implementar handler de jose-encryptor
  - [x] 6.1 Implementar `jose-encryptor/src/handler.js`
    - Declarar `let cachedPublicKey = null` en el scope del módulo (fuera del handler)
    - Implementar función `getKey()` con patrón lazy: si `cachedPublicKey` es null, recuperar PEM de Secrets Manager e importar con `importSPKI`; retornar la llave cacheada
    - Implementar función `isValidPayload(payload)`: retorna `true` solo si es objeto no-array, no-null, con al menos una clave
    - Implementar función `isOversized(payload)`: serializar con `JSON.stringify` y verificar que `Buffer.byteLength` ≤ 256 * 1024
    - Implementar `exports.handler` con la secuencia: validar `event.payload` (400 si ausente), validar tipo/vacío (400), validar tamaño (400), recuperar llave (500 si falla), cifrar (500 si falla), retornar 200 con `{ token }`
    - Incluir header `'Content-Type': 'application/json'` en todas las respuestas
    - _Requerimientos: 2.1, 2.4, 2.5, 2.6, 2.7, 2.8, 2.9, 2.10_
  - [x] 6.2 Escribir pruebas unitarias para jose-encryptor handler
    - Crear `jose-encryptor/tests/handler.test.js` con mocks de `@aws-sdk/client-secrets-manager`
    - Cubrir: payload válido → HTTP 200 con token de 5 partes; sin campo `payload` → HTTP 400; payload string/número/array/null/`{}` → HTTP 400; payload > 256 KB → HTTP 400; fallo en Secrets Manager → HTTP 500
    - _Requerimientos: 5.1, 5.2, 5.5_

- [x] 7. Implementar handler de jose-decryptor
  - [x] 7.1 Implementar `jose-decryptor/src/handler.js`
    - Declarar `let cachedPrivateKey = null` en el scope del módulo
    - Implementar función `getKey()` con patrón lazy para la llave privada
    - Implementar función `isValidJWEFormat(token)`: verificar que el string tiene exactamente 5 partes separadas por `.` y que el header decodificado contiene `alg: 'RSA-OAEP-256'` y `enc: 'A256GCM'`
    - Implementar `exports.handler` con la secuencia: validar `event.token` (400 si ausente), validar formato JWE (400), recuperar llave (500 si falla), descifrar con manejo diferenciado de errores jose (`ERR_JWE_DECRYPTION_FAILED` → 422, otros → 500), retornar 200 con `{ payload }`
    - Distinguir key mismatch de integrity failure analizando el mensaje del error `JWEDecryptionFailed`
    - _Requerimientos: 3.1, 3.4, 3.5, 3.6, 3.7, 3.8, 3.9, 3.10, 3.11_
  - [x] 7.2 Escribir pruebas unitarias para jose-decryptor handler
    - Crear `jose-decryptor/tests/handler.test.js` con mocks de `@aws-sdk/client-secrets-manager`
    - Cubrir: token JWE válido → HTTP 200 con payload original (deep equal); sin campo `token` → HTTP 400; token con 4 partes → HTTP 400; token con 6 partes → HTTP 400; token cifrado con llave diferente → HTTP 422; token corrompido → HTTP 422; fallo en Secrets Manager → HTTP 500
    - _Requerimientos: 5.3, 5.4, 5.5_

- [x] 8. Checkpoint — Ejecutar pruebas unitarias
  - Ejecutar `npx jest --runInBand` en `jose-encryptor/` y `jose-decryptor/`. Todos los casos unitarios deben pasar. Consultar al usuario si surgen dudas.

- [x] 9. Implementar script generate-keys.js
  - [x] 9.1 Implementar `scripts/generate-keys.js`
    - Generar par RSA 2048-bit con `crypto.generateKeyPair('rsa', { modulusLength: 2048 })` (promisificado)
    - Exportar llave pública en formato SPKI PEM y llave privada en formato PKCS8 PEM
    - Leer `PUBLIC_KEY_SECRET_NAME` y `PRIVATE_KEY_SECRET_NAME` de variables de entorno
    - Para cada llave: intentar `CreateSecretCommand`; si el secreto ya existe (`ResourceExistsException`), usar `UpdateSecretCommand` para sobreescribir
    - En caso de fallo de generación criptográfica: `process.exit(1)` con mensaje que identifica la etapa
    - En caso de fallo de Secrets Manager: `process.exit(1)` con nombre del secreto afectado y causa AWS
    - En caso de éxito: `process.exit(0)` con confirmación de almacenamiento de ambas llaves
    - _Requerimientos: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.7_

## Notes

- Cada tarea referencia requerimientos específicos para trazabilidad
- Los checkpoints garantizan validación incremental
- Las pruebas de propiedades validan invariantes universales con fast-check (mínimo 100 iteraciones)
- Las pruebas unitarias validan ejemplos concretos y casos de error
- Todos los mocks de AWS deben usarse en las pruebas para evitar dependencias de conectividad real
- El patrón de caché en módulo (`let cachedKey = null`) garantiza una sola llamada a Secrets Manager por contenedor de ejecución (cold start)
- El Requerimiento 7 (despliegue en AWS) no se incluye en las tareas de codificación ya que requiere operaciones de infraestructura fuera del alcance de un agente de código

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["2.1", "2.2"] },
    { "id": 1, "tasks": ["3.1", "4.1"] },
    { "id": 2, "tasks": ["6.1", "7.1"] },
    { "id": 3, "tasks": ["6.2", "7.2"] },
    { "id": 4, "tasks": ["8"] },
    { "id": 5, "tasks": ["9.1", "9.2", "9.3", "9.4", "9.5", "9.6", "9.7"] },
    { "id": 6, "tasks": ["10.1"] },
    { "id": 7, "tasks": ["11.1", "11.2"] }
  ]
}
```
