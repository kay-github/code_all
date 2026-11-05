import { createHmac, timingSafeEqual } from "node:crypto";
import { cookies } from "next/headers";
import { APP_CONFIG } from "@/lib/config";
import { NOTES_BASE_PATH } from "@/lib/paths";

const ADMIN_COOKIE = "qs_notes_admin";
const cookieOptions = {
  httpOnly: true,
  sameSite: "strict" as const,
  path: NOTES_BASE_PATH,
  secure: process.env.NODE_ENV === "production",
};

function sign(value: string): string {
  return createHmac("sha256", APP_CONFIG.sessionSecret).update(value).digest("hex");
}

function buildToken(payload: string): string {
  return `${payload}.${sign(payload)}`;
}

function verifyToken(token: string): string | null {
  const splitIndex = token.lastIndexOf(".");
  if (splitIndex < 1) {
    return null;
  }

  const payload = token.slice(0, splitIndex);
  const signature = token.slice(splitIndex + 1);
  const expected = sign(payload);

  const a = Buffer.from(signature);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return null;
  }

  return payload;
}

function expiresAt(): number {
  const oneDayMs = 24 * 60 * 60 * 1000;
  return Date.now() + APP_CONFIG.sessionDays * oneDayMs;
}

export function spaceCookieName(slug: string): string {
  return `qs_notes_space_${slug}`;
}

// 会话 cookie 绑定当前密码哈希的指纹：管理员改密后所有旧会话立即失效
function secretFingerprint(secret: string): string {
  return createHmac("sha256", APP_CONFIG.sessionSecret).update(secret).digest("hex").slice(0, 16);
}

export async function setSpaceSession(slug: string, passwordHash: string): Promise<void> {
  const store = await cookies();
  const payload = `${slug}:${expiresAt()}:${secretFingerprint(passwordHash)}`;
  store.set(spaceCookieName(slug), buildToken(payload), {
    ...cookieOptions,
    maxAge: APP_CONFIG.sessionDays * 24 * 60 * 60,
  });
}

export async function clearSpaceSession(slug: string): Promise<void> {
  const store = await cookies();
  store.set(spaceCookieName(slug), "", { ...cookieOptions, maxAge: 0 });
}

export async function canWriteWithSpaceCookie(slug: string, passwordHash: string | null): Promise<boolean> {
  if (!passwordHash) {
    return false;
  }

  const store = await cookies();
  const token = store.get(spaceCookieName(slug))?.value;
  if (!token) {
    return false;
  }

  const payload = verifyToken(token);
  if (!payload) {
    return false;
  }

  const [tokenSlug, expireText, fingerprint] = payload.split(":");
  const expire = Number(expireText);
  if (tokenSlug !== slug || Number.isNaN(expire) || expire < Date.now()) {
    return false;
  }

  // 指纹不匹配说明密码已被修改（或旧格式 cookie），要求重新验证
  if (fingerprint !== secretFingerprint(passwordHash)) {
    return false;
  }

  return true;
}

export async function setAdminSession(): Promise<void> {
  const store = await cookies();
  const payload = `admin:${expiresAt()}:${secretFingerprint(APP_CONFIG.adminPassword)}`;
  store.set(ADMIN_COOKIE, buildToken(payload), {
    ...cookieOptions,
    maxAge: APP_CONFIG.sessionDays * 24 * 60 * 60,
  });
}

export async function clearAdminSession(): Promise<void> {
  const store = await cookies();
  store.set(ADMIN_COOKIE, "", { ...cookieOptions, maxAge: 0 });
}

export async function isAdminAuthed(): Promise<boolean> {
  const store = await cookies();
  const token = store.get(ADMIN_COOKIE)?.value;
  if (!token) {
    return false;
  }

  const payload = verifyToken(token);
  if (!payload) {
    return false;
  }

  const [name, expireText, fingerprint] = payload.split(":");
  const expire = Number(expireText);
  return (
    name === "admin" &&
    !Number.isNaN(expire) &&
    expire > Date.now() &&
    fingerprint === secretFingerprint(APP_CONFIG.adminPassword)
  );
}
