import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { APP_CONFIG } from "@/lib/config";

const TEXT_PREFIX_V1 = "enc:v1:";
const TEXT_PREFIX_V2 = "enc:v2:";
const BYTES_PREFIX_V1 = Buffer.from("ENC1");
const BYTES_PREFIX_V2 = Buffer.from("ENC2");
const IV_LENGTH = 12;
const TAG_LENGTH = 16;

function keyFromSecret(secret: string): Buffer {
  return createHash("sha256").update(secret).digest();
}

function legacySecrets(): string[] {
  return [...new Set([APP_CONFIG.dataEncryptionKey, APP_CONFIG.sessionSecret].filter(Boolean))];
}

function encryptRaw(data: Buffer, secret: string): Buffer {
  const key = keyFromSecret(secret);
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(data), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, encrypted]);
}

function decryptRaw(data: Buffer, secret: string): Buffer {
  if (data.length < IV_LENGTH + TAG_LENGTH) {
    throw new Error("Encrypted payload is truncated");
  }
  const key = keyFromSecret(secret);
  const iv = data.subarray(0, IV_LENGTH);
  const tag = data.subarray(IV_LENGTH, IV_LENGTH + TAG_LENGTH);
  const payload = data.subarray(IV_LENGTH + TAG_LENGTH);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(payload), decipher.final()]);
}

function decryptWithSecrets(data: Buffer, secrets: string[]): Buffer {
  for (const secret of secrets) {
    try {
      return decryptRaw(data, secret);
    } catch {
      // Legacy v1 data may have used either the data key or the old session key.
    }
  }
  throw new Error("Encrypted payload could not be decrypted with the configured keys");
}

export function encryptText(text: string): string {
  const payload = encryptRaw(Buffer.from(text, "utf8"), APP_CONFIG.dataEncryptionKey).toString("base64");
  return `${TEXT_PREFIX_V2}${payload}`;
}

export function decryptText(text: string): string {
  const isV2 = text.startsWith(TEXT_PREFIX_V2);
  const isV1 = text.startsWith(TEXT_PREFIX_V1);
  if (!isV1 && !isV2) {
    return text;
  }
  const prefix = isV2 ? TEXT_PREFIX_V2 : TEXT_PREFIX_V1;
  const base64 = text.slice(prefix.length);
  if (!base64) {
    return "";
  }

  const secrets = isV2 ? [APP_CONFIG.dataEncryptionKey] : legacySecrets();
  return decryptWithSecrets(Buffer.from(base64, "base64"), secrets).toString("utf8");
}

export function encryptBytes(data: Uint8Array): Buffer {
  const payload = encryptRaw(Buffer.from(data), APP_CONFIG.dataEncryptionKey);
  return Buffer.concat([BYTES_PREFIX_V2, payload]);
}

export function decryptBytes(data: Uint8Array): Buffer {
  const raw = Buffer.from(data);
  const isV2 = raw.subarray(0, BYTES_PREFIX_V2.length).equals(BYTES_PREFIX_V2);
  const isV1 = raw.subarray(0, BYTES_PREFIX_V1.length).equals(BYTES_PREFIX_V1);
  if (!isV1 && !isV2) {
    return raw;
  }

  const prefixLength = isV2 ? BYTES_PREFIX_V2.length : BYTES_PREFIX_V1.length;
  const secrets = isV2 ? [APP_CONFIG.dataEncryptionKey] : legacySecrets();
  return decryptWithSecrets(raw.subarray(prefixLength), secrets);
}
