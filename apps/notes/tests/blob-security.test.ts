import { describe, expect, test } from "bun:test";
import { assetRedirectUrl, canInlineAsset, safeAssetHeaders } from "@/lib/asset-response";
import { blobAssetId, parseTrustedBlobUrl, trustedBlobPathname } from "@/lib/blob-security";

describe("Blob URL trust boundary", () => {
  const trusted = "https://store.private.blob.vercel-storage.com/folder/report.txt";

  test("accepts Vercel Blob HTTPS URLs and produces stable IDs", () => {
    expect(parseTrustedBlobUrl(trusted)?.hostname).toBe("store.private.blob.vercel-storage.com");
    expect(trustedBlobPathname(trusted)).toBe("folder/report.txt");
    expect(blobAssetId(trusted)).toBe(blobAssetId(trusted));
  });

  test("rejects external, insecure, credentialed, and empty URLs", () => {
    expect(parseTrustedBlobUrl("https://example.com/file.txt")).toBeNull();
    expect(parseTrustedBlobUrl("http://store.private.blob.vercel-storage.com/file.txt")).toBeNull();
    expect(parseTrustedBlobUrl("https://user:pass@store.private.blob.vercel-storage.com/file.txt")).toBeNull();
    expect(parseTrustedBlobUrl("https://store.private.blob.vercel-storage.com/")).toBeNull();
  });
});

describe("asset response headers", () => {
  test("allows passive preview formats inline without shared caching", () => {
    expect(canInlineAsset("image/png; charset=binary")).toBeTrue();
    const headers = safeAssetHeaders("photo.png", "image/png", 42);
    expect(headers["Content-Disposition"].startsWith("inline;")).toBeTrue();
    expect(headers["Content-Type"]).toBe("image/png");
    expect(headers["Cache-Control"]).toBe("private, no-store");
    expect(headers["X-Content-Type-Options"]).toBe("nosniff");
  });

  test("forces active content to download as opaque bytes", () => {
    for (const mimeType of ["text/html", "image/svg+xml", "application/javascript"]) {
      expect(canInlineAsset(mimeType)).toBeFalse();
      const headers = safeAssetHeaders("payload.html", mimeType, 42);
      expect(headers["Content-Disposition"].startsWith("attachment;")).toBeTrue();
      expect(headers["Content-Type"]).toBe("application/octet-stream");
      expect(headers["Content-Security-Policy"]).toContain("sandbox");
    }
  });

  test("keeps Blob downloads on signed CDN URLs and forces active content to download", () => {
    const signed = "https://store.private.blob.vercel-storage.com/report.html?token=abc&signature=xyz";
    expect(assetRedirectUrl(signed, "image/png")).toBe(signed);

    const forced = new URL(assetRedirectUrl(signed, "text/html"));
    expect(forced.searchParams.get("download")).toBe("1");
    expect(forced.searchParams.get("token")).toBe("abc");
    expect(forced.searchParams.get("signature")).toBe("xyz");
  });
});
