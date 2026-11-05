import bcrypt from "bcryptjs";
import { createHash, timingSafeEqual } from "node:crypto";

const ROUNDS = 10;

export async function hashPassword(raw: string): Promise<string> {
  return bcrypt.hash(raw, ROUNDS);
}

export async function verifyPassword(raw: string, hash: string): Promise<boolean> {
  return bcrypt.compare(raw, hash);
}

export function secureTextEqual(left: string, right: string): boolean {
  const leftDigest = createHash("sha256").update(left).digest();
  const rightDigest = createHash("sha256").update(right).digest();
  return timingSafeEqual(leftDigest, rightDigest);
}
