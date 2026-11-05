import { describe, expect, test } from "bun:test";
import { createCipheriv, createHash, randomBytes } from "node:crypto";
import { APP_CONFIG } from "@/lib/config";
import { decryptBytes, decryptText, encryptBytes, encryptText } from "@/lib/crypto";

function legacyEncryptText(text: string, secret: string): string {
  const key = createHash("sha256").update(secret).digest();
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const encrypted = Buffer.concat([cipher.update(Buffer.from(text)), cipher.final()]);
  const payload = Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString("base64");
  return `enc:v1:${payload}`;
}

describe("encrypted content", () => {
  test("round-trips v2 text and bytes", () => {
    const text = "跨设备内容 v2";
    expect(decryptText(encryptText(text))).toBe(text);

    const bytes = new Uint8Array([0, 1, 2, 200, 255]);
    expect(decryptBytes(encryptBytes(bytes))).toEqual(Buffer.from(bytes));
  });

  test("reads legacy v1 content encrypted with the old session key", () => {
    const legacy = legacyEncryptText("legacy-data", APP_CONFIG.sessionSecret);
    expect(decryptText(legacy)).toBe("legacy-data");
  });

  test("fails loudly when encrypted data is corrupted", () => {
    const encrypted = encryptText("important");
    const payload = Buffer.from(encrypted.slice("enc:v2:".length), "base64");
    payload[payload.length - 1] ^= 1;
    expect(() => decryptText(`enc:v2:${payload.toString("base64")}`)).toThrow();
  });
});
