import { getDownloadUrl } from "@vercel/blob";

const SAFE_INLINE_MIME_TYPES = new Set([
  "image/avif",
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/webp",
  "video/mp4",
  "video/ogg",
  "video/webm",
]);

function normalizedMimeType(mimeType: string): string {
  return mimeType.split(";", 1)[0]?.trim().toLowerCase() || "application/octet-stream";
}

export function canInlineAsset(mimeType: string): boolean {
  return SAFE_INLINE_MIME_TYPES.has(normalizedMimeType(mimeType));
}

export function assetRedirectUrl(presignedUrl: string, mimeType: string): string {
  return canInlineAsset(mimeType) ? presignedUrl : getDownloadUrl(presignedUrl);
}

function fallbackFilename(name: string): string {
  return name
    .replace(/[^\x20-\x7e]/g, "_")
    .replace(/["\\\r\n]/g, "_")
    .slice(0, 150) || "download";
}

export function safeAssetHeaders(name: string, mimeType: string, size: number): Record<string, string> {
  const normalized = normalizedMimeType(mimeType);
  const inline = canInlineAsset(normalized);
  const disposition = inline ? "inline" : "attachment";

  return {
    "Content-Type": inline ? normalized : "application/octet-stream",
    "Content-Length": String(size),
    "Content-Disposition": `${disposition}; filename="${fallbackFilename(name)}"; filename*=UTF-8''${encodeURIComponent(name)}`,
    "Cache-Control": "private, no-store",
    "Content-Security-Policy": "sandbox; default-src 'none'",
    "Cross-Origin-Resource-Policy": "same-origin",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
  };
}
