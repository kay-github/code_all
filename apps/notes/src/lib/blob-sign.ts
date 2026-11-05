import { issueSignedToken, presignUrl, type IssuedSignedToken } from "@vercel/blob";
import { parseTrustedBlobUrl } from "@/lib/blob-security";

// 签名 token 有效期 1 小时；单个下载直链有效期 10 分钟
const TOKEN_TTL_MS = 60 * 60 * 1000;
const URL_TTL_MS = 10 * 60 * 1000;

let cachedToken: IssuedSignedToken | null = null;
let pendingToken: Promise<IssuedSignedToken> | null = null;

// issueSignedToken 会请求 Blob 控制面 API，进程内缓存复用，避免每次下载都多一次网络往返
async function getSignedToken(): Promise<IssuedSignedToken> {
  const now = Date.now();
  if (cachedToken && cachedToken.validUntil - now > URL_TTL_MS + 60 * 1000) {
    return cachedToken;
  }

  if (!pendingToken) {
    pendingToken = issueSignedToken({
      pathname: "*",
      operations: ["get", "head"],
      validUntil: now + TOKEN_TTL_MS,
    })
      .then((token) => {
        cachedToken = token;
        return token;
      })
      .finally(() => {
        pendingToken = null;
      });
  }

  return pendingToken;
}

type PathStyle = "decoded" | "encoded";

// 中文等非 ASCII 文件名存在“按编码前还是编码后签名”的歧义，首次通过 HEAD 探测确认后进程内记住结果
let verifiedStyle: PathStyle | null = null;

function candidatePathnames(blobUrl: string): { style: PathStyle; pathname: string }[] {
  const trustedUrl = parseTrustedBlobUrl(blobUrl);
  if (!trustedUrl) {
    throw new Error("Untrusted Blob URL");
  }
  const encoded = trustedUrl.pathname.slice(1);
  let decoded = encoded;
  try {
    decoded = decodeURIComponent(encoded);
  } catch {
    // 非法编码时只按原样签名
  }

  if (decoded === encoded) {
    return [{ style: "decoded", pathname: decoded }];
  }

  const ordered: { style: PathStyle; pathname: string }[] = [
    { style: "decoded", pathname: decoded },
    { style: "encoded", pathname: encoded },
  ];
  return verifiedStyle === "encoded" ? ordered.reverse() : ordered;
}

async function presignFor(pathname: string, operation: "get" | "head"): Promise<string> {
  const token = await getSignedToken();
  const { presignedUrl } = await presignUrl(token, {
    operation,
    pathname,
    access: "private",
    validUntil: Date.now() + URL_TTL_MS,
  });
  return presignedUrl;
}

// 生成带签名的 CDN 直链，浏览器直接从 Blob CDN 下载，文件字节不再经过 serverless 函数中转。
// 失败返回 null，调用方回退到代理下载。
export async function presignBlobDownloadUrl(blobUrl: string): Promise<string | null> {
  try {
    const candidates = candidatePathnames(blobUrl);

    // 无歧义（纯 ASCII 路径）或已探测过的情况直接签名返回
    if (candidates.length === 1 || verifiedStyle !== null) {
      return await presignFor(candidates[0].pathname, "get");
    }

    for (const candidate of candidates) {
      const headUrl = await presignFor(candidate.pathname, "head");
      const res = await fetch(headUrl, { method: "HEAD" });
      if (res.ok) {
        verifiedStyle = candidate.style;
        return await presignFor(candidate.pathname, "get");
      }
    }

    return null;
  } catch (error) {
    console.error("[presignBlobDownloadUrl]", error);
    return null;
  }
}

export const BLOB_DOWNLOAD_URL_TTL_MS = URL_TTL_MS;
