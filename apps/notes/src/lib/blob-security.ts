import { createHash } from "node:crypto";

const BLOB_HOST_SUFFIX = ".blob.vercel-storage.com";

export function parseTrustedBlobUrl(value: string): URL | null {
  try {
    const url = new URL(value);
    if (
      url.protocol !== "https:" ||
      !url.hostname.endsWith(BLOB_HOST_SUFFIX) ||
      url.username ||
      url.password ||
      !url.pathname.slice(1)
    ) {
      return null;
    }
    return url;
  } catch {
    return null;
  }
}

export function trustedBlobPathname(value: string): string | null {
  return parseTrustedBlobUrl(value)?.pathname.slice(1) || null;
}

export function blobAssetId(value: string): string {
  const url = parseTrustedBlobUrl(value);
  if (!url) {
    throw new Error("Untrusted Blob URL");
  }
  const digest = createHash("sha256").update(`${url.hostname}${url.pathname}`).digest("hex");
  return `blob_${digest.slice(0, 32)}`;
}
