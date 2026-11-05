export const MAX_FILE_SIZE = 50 * 1024 * 1024;
export const MAX_NOTE_LENGTH = 50_000;

type SecretName = "ADMIN_PASSWORD" | "SESSION_SECRET" | "DATA_ENCRYPTION_KEY";

function requiredSecret(name: SecretName, devFallback: string): string {
  const value = process.env[name]?.trim();
  if (value) {
    return value;
  }
  if (process.env.NODE_ENV === "production") {
    throw new Error(`[quick-space] 环境变量 ${name} 未配置，生产环境必须设置`);
  }
  return devFallback;
}

const adminPassword = requiredSecret("ADMIN_PASSWORD", "dev-admin-password");
const sessionSecret = requiredSecret("SESSION_SECRET", "quick-space-dev-session-secret");
const dataEncryptionKey = requiredSecret("DATA_ENCRYPTION_KEY", "quick-space-dev-data-secret");

if (process.env.NODE_ENV === "production") {
  if (adminPassword === "6322Kay") {
    throw new Error("[quick-space] ADMIN_PASSWORD 仍为已公开的示例值，必须先轮换");
  }
  if (dataEncryptionKey === sessionSecret) {
    throw new Error("[quick-space] DATA_ENCRYPTION_KEY 必须与 SESSION_SECRET 使用不同密钥");
  }
}

export const APP_CONFIG = {
  defaultSpaceSlug: process.env.DEFAULT_SPACE_SLUG || "public",
  defaultSpaceTitle: process.env.DEFAULT_SPACE_TITLE || "公共空间",
  adminPassword,
  sessionSecret,
  dataEncryptionKey,
  sessionDays: 7,
};
