# Requirements Document

## Introduction

Este documento describe los requerimientos para el desarrollo de dos funciones AWS Lambda que implementan cifrado y descifrado de payloads usando el estándar **JWE (JSON Web Encryption)** con criptografía asimétrica RSA. Las funciones forman parte de un sistema de seguridad para proteger datos sensibles en tránsito dentro de una arquitectura serverless en AWS.

- **jose-encryptor**: Recibe un payload JSON y retorna un token JWE cifrado usando la llave pública RSA.
- **jose-decryptor**: Recibe un token JWE y retorna el payload JSON descifrado usando la llave privada RSA.

Ambas lambdas se desarrollan siguiendo la metodología Spec-Driven Development (SDD) e incluyen pruebas unitarias documentadas.

---

## Glossary

- **JWE**: JSON Web Encryption. Estándar definido en RFC 7516 para representar contenido cifrado usando estructuras JSON.
- **JWT**: JSON Web Token. Estándar compacto para transmitir información entre partes como un objeto JSON.
- **RSA**: Algoritmo de criptografía asimétrica que utiliza un par de llaves (pública y privada).
- **Llave_Pública**: Componente del par RSA utilizado para cifrar datos. Puede distribuirse libremente.
- **Llave_Privada**: Componente del par RSA utilizado para descifrar datos. Debe mantenerse en secreto.
- **Par_RSA**: Conjunto formado por la Llave_Pública y la Llave_Privada generadas conjuntamente.
- **Payload**: Objeto JSON que contiene los datos a cifrar o que resultan del descifrado.
- **Token_JWE**: Cadena de texto en formato JWE Compact Serialization que representa el payload cifrado.
- **Lambda_Encriptador**: Función AWS Lambda denominada `jose-encryptor` responsable del cifrado.
- **Lambda_Desencriptador**: Función AWS Lambda denominada `jose-decryptor` responsable del descifrado.
- **AWS_Secrets_Manager**: Servicio de AWS utilizado para almacenar y recuperar secretos de forma segura.
- **AWS_Lambda**: Servicio de computación serverless de AWS que ejecuta código en respuesta a eventos.
- **Algoritmo_Cifrado_Llave**: Algoritmo RSA-OAEP-256 usado para cifrar la llave de contenido simétrica.
- **Algoritmo_Cifrado_Contenido**: Algoritmo AES-256-GCM usado para cifrar el contenido del payload.
- **SDD**: Spec-Driven Development. Metodología de desarrollo guiada por especificaciones formales.
- **Handler**: Función de entrada de una AWS Lambda que recibe el evento y el contexto de ejecución.
- **Script_Generación**: Script ejecutable (CLI o Lambda auxiliar) que genera el Par_RSA y lo almacena en AWS_Secrets_Manager.

---

## Requirements

### Requerimiento 1: Generación del Par de Llaves RSA

**User Story:** Como administrador del sistema, quiero generar un par de llaves RSA asimétricas, para que las lambdas puedan cifrar y descifrar payloads de forma segura.

#### Criterios de Aceptación

1. THE Par_RSA SHALL estar compuesto por una Llave_Pública y una Llave_Privada de 2048 bits mínimo.
2. THE Par_RSA SHALL utilizar el formato PEM para la representación de ambas llaves.
3. WHEN el Script_Generación es ejecutado, THE Llave_Privada SHALL almacenarse en AWS_Secrets_Manager bajo una ruta de secreto definida mediante una variable de entorno configurable (por ejemplo, `PRIVATE_KEY_SECRET_NAME`).
4. WHEN el Script_Generación es ejecutado, THE Llave_Pública SHALL almacenarse en AWS_Secrets_Manager bajo una ruta de secreto definida mediante una variable de entorno configurable (por ejemplo, `PUBLIC_KEY_SECRET_NAME`).
5. IF el secreto ya existe en AWS_Secrets_Manager al momento de la generación, THEN THE Script_Generación SHALL sobreescribir el valor existente con el nuevo Par_RSA generado.
6. IF el almacenamiento de cualquiera de las llaves en AWS_Secrets_Manager falla, THEN THE Script_Generación SHALL terminar con código de salida distinto de cero y emitir un mensaje de error que incluya el nombre del secreto afectado y la causa del fallo reportada por AWS.
7. IF la generación criptográfica del Par_RSA falla, THEN THE Script_Generación SHALL terminar con código de salida distinto de cero y emitir un mensaje de error que identifique la etapa de generación fallida.

---

### Requerimiento 2: Cifrado de Payload (Lambda Encriptador)

**User Story:** Como consumidor de la API, quiero enviar un payload JSON a la Lambda_Encriptador, para que retorne un Token_JWE cifrado que proteja los datos sensibles.

#### Criterios de Aceptación

1. WHEN la Lambda_Encriptador recibe un evento con un campo `payload` de tipo objeto JSON válido y no vacío, THE Lambda_Encriptador SHALL retornar un Token_JWE en formato JWE Compact Serialization compuesto exactamente por 5 partes separadas por puntos (`.`).
2. THE Lambda_Encriptador SHALL utilizar el Algoritmo_Cifrado_Llave RSA-OAEP-256 para cifrar la llave de contenido.
3. THE Lambda_Encriptador SHALL utilizar el Algoritmo_Cifrado_Contenido AES-256-GCM para cifrar el contenido del payload.
4. WHEN la Lambda_Encriptador inicia un nuevo contenedor de ejecución (cold start), THE Lambda_Encriptador SHALL recuperar la Llave_Pública desde AWS_Secrets_Manager y mantenerla en memoria para invocaciones subsecuentes dentro del mismo contenedor.
5. IF el evento recibido no contiene el campo `payload`, THEN THE Lambda_Encriptador SHALL retornar un código HTTP 400 con un mensaje de error `"Missing required field: payload"`.
6. IF el campo `payload` es un objeto JSON vacío `{}` o no es un objeto JSON (por ejemplo, es un string, número, array o null), THEN THE Lambda_Encriptador SHALL retornar un código HTTP 400 con un mensaje de error `"Invalid payload: must be a non-empty valid JSON object"`.
7. IF la recuperación de la Llave_Pública desde AWS_Secrets_Manager falla, THEN THE Lambda_Encriptador SHALL retornar un código HTTP 500 con un mensaje de error `"Failed to retrieve encryption key"`.
8. IF el proceso de cifrado falla, THEN THE Lambda_Encriptador SHALL retornar un código HTTP 500 con un mensaje de error `"Encryption failed"`.
9. WHEN el cifrado es exitoso, THE Lambda_Encriptador SHALL retornar un código HTTP 200 junto con el Token_JWE en el campo `token` de la respuesta.
10. THE Lambda_Encriptador SHALL rechazar payloads cuyo tamaño serializado supere 256 KB, retornando un código HTTP 400 con un mensaje de error `"Payload too large: maximum size is 256KB"`.

---

### Requerimiento 3: Descifrado de Token JWE (Lambda Desencriptador)

**User Story:** Como consumidor de la API, quiero enviar un Token_JWE a la Lambda_Desencriptador, para que retorne el payload JSON original descifrado.

#### Criterios de Aceptación

1. WHEN la Lambda_Desencriptador recibe un evento con un campo `token` que contiene un Token_JWE válido, THE Lambda_Desencriptador SHALL retornar el Payload original en formato objeto JSON.
2. THE Lambda_Desencriptador SHALL utilizar el Algoritmo_Cifrado_Llave RSA-OAEP-256 para descifrar la llave de contenido.
3. THE Lambda_Desencriptador SHALL utilizar el Algoritmo_Cifrado_Contenido AES-256-GCM para descifrar el contenido del token.
4. WHEN la Lambda_Desencriptador inicia un nuevo contenedor de ejecución (cold start), THE Lambda_Desencriptador SHALL recuperar la Llave_Privada desde AWS_Secrets_Manager y mantenerla en memoria para invocaciones subsecuentes dentro del mismo contenedor.
5. IF el evento recibido no contiene el campo `token`, THEN THE Lambda_Desencriptador SHALL retornar un código HTTP 400 con un mensaje de error `"Missing required field: token"`.
6. IF el campo `token` no tiene el formato JWE Compact Serialization (exactamente 5 partes separadas por puntos) o declara algoritmos distintos a RSA-OAEP-256 y AES-256-GCM en su cabecera, THEN THE Lambda_Desencriptador SHALL retornar un código HTTP 400 con un mensaje de error `"Invalid token format: must be a valid JWE Compact Serialization"`.
7. IF la recuperación de la Llave_Privada desde AWS_Secrets_Manager falla, THEN THE Lambda_Desencriptador SHALL retornar un código HTTP 500 con un mensaje de error `"Failed to retrieve decryption key"`.
8. IF el Token_JWE fue cifrado con una Llave_Pública cuya Llave_Privada correspondiente es diferente a la Llave_Privada disponible en AWS_Secrets_Manager, THEN THE Lambda_Desencriptador SHALL retornar un código HTTP 422 con un mensaje de error `"Decryption failed: key mismatch"`.
9. IF el Token_JWE ha sido modificado o corrompido después de su generación (fallo de verificación de integridad AES-GCM), THEN THE Lambda_Desencriptador SHALL retornar un código HTTP 422 con un mensaje de error `"Decryption failed: token integrity check failed"`.
10. IF el proceso de descifrado falla por cualquier otra causa no contemplada en los criterios anteriores, THEN THE Lambda_Desencriptador SHALL retornar un código HTTP 500 con un mensaje de error `"Decryption failed"`.
11. WHEN el descifrado es exitoso, THE Lambda_Desencriptador SHALL retornar un código HTTP 200 junto con el Payload en el campo `payload` de la respuesta.

---

### Requerimiento 4: Propiedad de Round-Trip (Cifrado → Descifrado)

**User Story:** Como desarrollador, quiero garantizar que cualquier payload JSON cifrado por la Lambda_Encriptador pueda ser descifrado por la Lambda_Desencriptador para recuperar el payload original, para que el sistema sea confiable y correcto.

#### Criterios de Aceptación

1. FOR ALL objetos JSON válidos y no vacíos usados como Payload, WHEN el Payload es cifrado por la Lambda_Encriptador usando la Llave_Pública del Par_RSA activo y el Token_JWE resultante es descifrado por la Lambda_Desencriptador usando la Llave_Privada del mismo Par_RSA, THE Lambda_Desencriptador SHALL retornar un objeto JSON con exactamente los mismos campos y valores que el Payload original (igualdad profunda, propiedad round-trip).
2. THE sistema SHALL preservar el tipo de dato de cada valor del Payload original (string, number, boolean, null, array, objeto anidado) durante el ciclo completo de cifrado y descifrado.
3. WHEN el mismo Payload es cifrado dos veces consecutivas por la Lambda_Encriptador con el mismo Par_RSA, THE Lambda_Encriptador SHALL producir dos Token_JWE con valores distintos en al menos una de sus 5 partes (no determinismo garantizado por IV/CEK aleatorio), y ambos Token_JWE SHALL ser descifrados correctamente por la Lambda_Desencriptador retornando el Payload original.
4. THE propiedad round-trip SHALL mantenerse para Payloads que contengan caracteres Unicode, valores numéricos de punto flotante, arrays anidados y objetos con profundidad de hasta 10 niveles.

---

### Requerimiento 5: Pruebas Unitarias

**User Story:** Como desarrollador, quiero que cada lambda tenga pruebas unitarias documentadas, para que el comportamiento del sistema sea verificable y mantenible.

#### Criterios de Aceptación

1. THE Lambda_Encriptador SHALL tener una prueba unitaria que verifique que, dado un objeto JSON válido y no vacío en el campo `payload`, la respuesta tiene código HTTP 200 y el campo `token` contiene una cadena con exactamente 5 partes separadas por puntos.
2. THE Lambda_Encriptador SHALL tener pruebas unitarias que verifiquen que: (a) un evento sin campo `payload` retorna HTTP 400; (b) un campo `payload` con valor no-objeto (string, número, array, null) o vacío `{}` retorna HTTP 400; (c) un fallo simulado en la recuperación de la Llave_Pública retorna HTTP 500.
3. THE Lambda_Desencriptador SHALL tener una prueba unitaria que verifique que, dado un Token_JWE válido en el campo `token`, la respuesta tiene código HTTP 200 y el campo `payload` contiene el objeto JSON original con igualdad profunda.
4. THE Lambda_Desencriptador SHALL tener pruebas unitarias que verifiquen que: (a) un evento sin campo `token` retorna HTTP 400; (b) un campo `token` con formato incorrecto (menos o más de 5 partes) retorna HTTP 400; (c) un token cifrado con una llave diferente retorna HTTP 422; (d) un fallo simulado en la recuperación de la Llave_Privada retorna HTTP 500.
5. THE suite de pruebas de cada lambda SHALL reemplazar las llamadas a AWS_Secrets_Manager con mocks o stubs que no requieran conectividad real a AWS, de modo que las pruebas puedan ejecutarse en cualquier entorno de desarrollo local sin credenciales AWS.
6. WHEN las pruebas unitarias son ejecutadas, THE suite de pruebas SHALL completar su ejecución en menos de 60 segundos con todos los casos de los criterios 1 al 4 pasando exitosamente.
7. THE README de cada lambda SHALL incluir: (a) el comando exacto para instalar dependencias de desarrollo; (b) el comando exacto para ejecutar las pruebas unitarias; (c) la salida esperada que indica que todas las pruebas pasaron.

---

### Requerimiento 6: Estructura del Repositorio y SDD

**User Story:** Como desarrollador, quiero que el repositorio siga una estructura organizada con specs por lambda, para que el proyecto sea mantenible y siga la metodología SDD.

#### Criterios de Aceptación

1. THE repositorio SHALL contener un directorio `jose-encryptor/` con el código fuente de la Lambda_Encriptador.
2. THE repositorio SHALL contener un directorio `jose-decryptor/` con el código fuente de la Lambda_Desencriptador.
3. THE repositorio SHALL contener un directorio `.kiro/specs/jwe-lambda-functions/` con los archivos de requerimientos, diseño y tareas del feature.
4. THE Lambda_Encriptador SHALL tener un archivo `README.md` que incluya las siguientes secciones: (a) descripción del propósito de la lambda; (b) variables de entorno requeridas y sus valores esperados; (c) ejemplo de evento de entrada y respuesta de salida; (d) instrucciones para ejecutar las pruebas unitarias localmente.
5. THE Lambda_Desencriptador SHALL tener un archivo `README.md` que incluya las siguientes secciones: (a) descripción del propósito de la lambda; (b) variables de entorno requeridas y sus valores esperados; (c) ejemplo de evento de entrada y respuesta de salida; (d) instrucciones para ejecutar las pruebas unitarias localmente.
6. WHEN la Lambda_Encriptador es invocada con un payload válido, THE Lambda_Encriptador SHALL retornar HTTP 200 con el campo `token` sin necesidad de que la Lambda_Desencriptador esté desplegada, disponible o invocada durante esa ejecución.
7. WHEN la Lambda_Desencriptador es invocada con un Token_JWE válido, THE Lambda_Desencriptador SHALL retornar HTTP 200 con el campo `payload` sin necesidad de que la Lambda_Encriptador esté desplegada, disponible o invocada durante esa ejecución.

---

### Requerimiento 7: Despliegue en AWS

**User Story:** Como operador, quiero desplegar ambas lambdas en AWS y verificar su funcionamiento, para que el sistema esté disponible en producción.

#### Criterios de Aceptación

1. WHEN la Lambda_Encriptador es desplegada en AWS_Lambda e invocada con un evento que contiene un campo `payload` con un objeto JSON válido y no vacío, THE Lambda_Encriptador SHALL retornar un código HTTP 200 con el campo `token` en la respuesta.
2. WHEN la Lambda_Desencriptador es desplegada en AWS_Lambda e invocada con un evento que contiene un campo `token` con un Token_JWE válido generado por la Lambda_Encriptador, THE Lambda_Desencriptador SHALL retornar un código HTTP 200 con el campo `payload` en la respuesta.
3. THE Lambda_Encriptador SHALL tener configurado un rol IAM con permisos de lectura (`secretsmanager:GetSecretValue`) sobre el secreto de la Llave_Pública en AWS_Secrets_Manager, de modo que la recuperación de la llave no produzca un error de autorización.
4. THE Lambda_Desencriptador SHALL tener configurado un rol IAM con permisos de lectura (`secretsmanager:GetSecretValue`) sobre el secreto de la Llave_Privada en AWS_Secrets_Manager, de modo que la recuperación de la llave no produzca un error de autorización.
5. IF la Lambda_Encriptador o la Lambda_Desencriptador no tienen los permisos IAM necesarios para acceder a AWS_Secrets_Manager, THEN THE Lambda_Encriptador o Lambda_Desencriptador SHALL retornar un código HTTP 500 con un mensaje de error que indique fallo en la recuperación de la llave.
6. THE Lambda_Encriptador y THE Lambda_Desencriptador SHALL tener un timeout configurado de 30 segundos como máximo.
7. THE Lambda_Encriptador y THE Lambda_Desencriptador SHALL tener asignada una memoria mínima de 256 MB.
