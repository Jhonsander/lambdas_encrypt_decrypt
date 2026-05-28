# Requirements Document

## Introduction

Este documento describe los requisitos para desplegar las dos funciones AWS Lambda existentes (`jose-encryptor` y `jose-decryptor`) en AWS usando AWS SAM (Serverless Application Model). Las funciones ya están implementadas y testeadas localmente; el objetivo es automatizar su infraestructura como código, gestionar los secretos RSA en AWS Secrets Manager y verificar el funcionamiento end-to-end tras el despliegue.

## Glossary

- **SAM**: AWS Serverless Application Model — framework de IaC para definir y desplegar recursos serverless en AWS.
- **Template_SAM**: Archivo `template.yaml` que define los recursos AWS (Lambdas, IAM roles, parámetros) usando la sintaxis SAM/CloudFormation.
- **jose-encryptor**: Función Lambda Node.js que cifra un payload JSON usando JWE (RSA-OAEP-256 + AES-256-GCM) y devuelve un token JWE Compact Serialization.
- **jose-decryptor**: Función Lambda Node.js que descifra un token JWE Compact Serialization y devuelve el payload JSON original.
- **Secrets_Manager**: AWS Secrets Manager — servicio para almacenar y recuperar secretos como las claves RSA PEM.
- **Setup_Script**: Script Node.js que sube las claves PEM existentes a AWS Secrets Manager antes del despliegue SAM.
- **Integration_Test**: Script de prueba post-despliegue que invoca las Lambdas con AWS CLI para verificar el flujo completo encriptación → desencriptación.
- **JWE**: JSON Web Encryption — estándar para cifrado de contenido JSON (RFC 7516).
- **PEM**: Privacy Enhanced Mail — formato de texto para claves criptográficas RSA.
- **IAM_Role**: Rol de AWS Identity and Access Management que define los permisos de ejecución de cada Lambda.
- **Stack_SAM**: Conjunto de recursos AWS creados por un despliegue SAM/CloudFormation.

---

## Requirements

### Requirement 1: Definición de infraestructura SAM

**User Story:** Como desarrollador, quiero un archivo `template.yaml` SAM que defina ambas funciones Lambda con sus configuraciones, para poder desplegar la infraestructura de forma reproducible y versionada.

#### Acceptance Criteria

1. THE Template_SAM SHALL definir dos funciones Lambda: `JoseEncryptorFunction` y `JoseDecryptorFunction` con runtime `nodejs22.x`.
2. THE Template_SAM SHALL configurar el handler de `JoseEncryptorFunction` como `src/handler.handler` apuntando al directorio `jose-encryptor/`.
3. THE Template_SAM SHALL configurar el handler de `JoseDecryptorFunction` como `src/handler.handler` apuntando al directorio `jose-decryptor/`.
4. THE Template_SAM SHALL exponer parámetros SAM configurables `PublicKeySecretName` y `PrivateKeySecretName` con valores por defecto.
5. WHEN el Template_SAM es procesado por `sam build`, THE Template_SAM SHALL producir artefactos de despliegue válidos sin errores.
6. THE Template_SAM SHALL configurar la variable de entorno `PUBLIC_KEY_SECRET_NAME` en `JoseEncryptorFunction` usando el parámetro `PublicKeySecretName`.
7. THE Template_SAM SHALL configurar la variable de entorno `PRIVATE_KEY_SECRET_NAME` en `JoseDecryptorFunction` usando el parámetro `PrivateKeySecretName`.

---

### Requirement 2: Permisos IAM mínimos

**User Story:** Como operador de seguridad, quiero que cada Lambda tenga permisos IAM mínimos para leer únicamente su propio secreto de Secrets Manager, para cumplir el principio de mínimo privilegio.

#### Acceptance Criteria

1. THE Template_SAM SHALL crear un IAM Role dedicado para `JoseEncryptorFunction` y SHALL otorgar a ese role únicamente el permiso `secretsmanager:GetSecretValue` sobre el ARN del secreto de clave pública; ambas acciones (creación del role y asignación del permiso) son requeridas.
2. THE Template_SAM SHALL crear un IAM Role dedicado para `JoseDecryptorFunction` y SHALL otorgar a ese role únicamente el permiso `secretsmanager:GetSecretValue` sobre el ARN del secreto de clave privada; ambas acciones (creación del role y asignación del permiso) son requeridas.
3. IF `JoseEncryptorFunction` intenta acceder al secreto de clave privada, THEN THE Secrets_Manager SHALL denegar el acceso con un error de autorización.
4. IF `JoseDecryptorFunction` intenta acceder al secreto de clave pública, THEN THE Secrets_Manager SHALL denegar el acceso con un error de autorización.
5. THE Template_SAM SHALL incluir la política de ejecución básica de Lambda (`AWSLambdaBasicExecutionRole`) en cada IAM Role para permitir escritura de logs en CloudWatch.

---

### Requirement 3: Script de configuración de Secrets Manager

**User Story:** Como desarrollador, quiero un script automatizado que suba las claves PEM existentes a AWS Secrets Manager, para preparar el entorno antes del despliegue SAM sin pasos manuales en la consola AWS.

#### Acceptance Criteria

1. THE Setup_Script SHALL leer el archivo `public-key.pem` desde la raíz del proyecto como paso obligatorio previo; IF el archivo no puede leerse, THEN THE Setup_Script SHALL interrumpir la ejecución inmediatamente con un mensaje de error descriptivo y código de salida distinto de cero, sin intentar ninguna operación en Secrets Manager.
2. THE Setup_Script SHALL leer el archivo `private-key.pem` desde la raíz del proyecto como paso obligatorio previo; IF el archivo no puede leerse, THEN THE Setup_Script SHALL interrumpir la ejecución inmediatamente con un mensaje de error descriptivo y código de salida distinto de cero, sin intentar ninguna operación en Secrets Manager.
3. WHEN un secreto con el mismo nombre ya existe en Secrets Manager, THE Setup_Script SHALL actualizar el valor del secreto existente en lugar de crear uno nuevo.
4. WHEN la creación o actualización de un secreto falla, THE Setup_Script SHALL mostrar un mensaje de error descriptivo e interrumpir la ejecución con código de salida distinto de cero.
5. WHEN ambos secretos son creados o actualizados exitosamente, THE Setup_Script SHALL mostrar los ARNs de los secretos creados/actualizados.
6. THE Setup_Script SHALL aceptar los nombres de los secretos como argumentos de línea de comandos o variables de entorno, con valores por defecto razonables.

---

### Requirement 4: Proceso de despliegue SAM

**User Story:** Como desarrollador, quiero comandos claros y documentados para construir y desplegar el stack SAM, para poder reproducir el despliegue en cualquier entorno con AWS CLI configurado.

#### Acceptance Criteria

1. THE Stack_SAM SHALL poder construirse ejecutando `sam build` desde la raíz del proyecto sin errores.
2. THE Stack_SAM SHALL poder desplegarse ejecutando `sam deploy --guided` (primera vez) o `sam deploy` (despliegues subsiguientes) sin errores.
3. WHEN el despliegue SAM completa exitosamente, THE Stack_SAM SHALL mostrar los ARNs de las funciones Lambda desplegadas como outputs de CloudFormation.
4. THE Template_SAM SHALL incluir un archivo `samconfig.toml` con configuración por defecto para `sam deploy` (stack name, región, bucket S3 para artefactos, confirmación de cambios).
5. WHEN se ejecuta `sam deploy` con parámetros de override, THE Stack_SAM SHALL usar los valores de parámetros proporcionados en lugar de los valores por defecto.

---

### Requirement 5: Prueba de integración post-despliegue

**User Story:** Como desarrollador, quiero un script de prueba de integración que verifique el flujo completo encriptación → desencriptación usando las Lambdas desplegadas, para confirmar que el despliegue es funcional end-to-end.

#### Acceptance Criteria

1. THE Integration_Test SHALL invocar `JoseEncryptorFunction` con un payload JSON de prueba usando AWS CLI y verificar que la respuesta contiene un campo `token` con formato JWE válido (5 partes separadas por puntos).
2. WHEN `JoseEncryptorFunction` devuelve un token JWE con formato válido (5 partes separadas por puntos), THE Integration_Test SHALL invocar `JoseDecryptorFunction` con ese token y verificar que la respuesta contiene un campo `payload` equivalente al payload original; IF el token no tiene formato JWE válido, THEN THE Integration_Test SHALL omitir la invocación del desencriptador y reportar el error.
3. THE Integration_Test SHALL verificar que el `statusCode` de ambas respuestas Lambda es `200`.
4. WHEN cualquier invocación Lambda falla o devuelve un `statusCode` distinto de `200`, THE Integration_Test SHALL mostrar el error detallado e interrumpir la ejecución con código de salida distinto de cero.
5. THE Integration_Test SHALL aceptar el nombre del stack SAM como argumento para derivar los nombres de las funciones Lambda a invocar.
6. WHEN la prueba de integración completa exitosamente, THE Integration_Test SHALL mostrar un mensaje de confirmación indicando que el flujo encriptación → desencriptación funciona correctamente.

---

### Requirement 6: Configuración de recursos de las Lambdas

**User Story:** Como operador, quiero que las funciones Lambda tengan configuraciones de recursos adecuadas para su carga de trabajo criptográfica, para evitar timeouts o errores por falta de memoria.

#### Acceptance Criteria

1. THE Template_SAM SHALL configurar un timeout mínimo de 10 segundos para `JoseEncryptorFunction` para acomodar la latencia de Secrets Manager en cold start.
2. THE Template_SAM SHALL configurar un timeout mínimo de 10 segundos para `JoseDecryptorFunction` para acomodar la latencia de Secrets Manager en cold start.
3. THE Template_SAM SHALL configurar al menos 256 MB de memoria para `JoseEncryptorFunction` para soportar operaciones criptográficas RSA.
4. THE Template_SAM SHALL configurar al menos 256 MB de memoria para `JoseDecryptorFunction` para soportar operaciones criptográficas RSA.
