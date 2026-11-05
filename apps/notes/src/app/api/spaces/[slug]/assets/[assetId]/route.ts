import { NextResponse } from "next/server";
import { del, get } from "@vercel/blob";
import { canReadSpace, canWriteSpace } from "@/lib/space-permission";
import { prisma } from "@/lib/prisma";
import { getClientIp } from "@/lib/request";
import { writeAudit } from "@/lib/audit";
import { decryptBytes } from "@/lib/crypto";
import { presignBlobDownloadUrl } from "@/lib/blob-sign";
import { parseTrustedBlobUrl } from "@/lib/blob-security";
import { assetRedirectUrl, safeAssetHeaders } from "@/lib/asset-response";

type Context = { params: Promise<{ slug: string; assetId: string }> };

// 老的代理下载：文件字节流经 serverless 函数中转，仅作为签名直链失败时的兜底
async function proxyBlobDownload(blobUrl: string, name: string, mimeType: string, size: number) {
  const trustedUrl = parseTrustedBlobUrl(blobUrl);
  if (!trustedUrl) {
    return new NextResponse("Invalid Blob URL", { status: 502 });
  }

  const blobRes = await get(trustedUrl.toString(), { access: "private" }).catch((error) => {
    console.error("[asset-download:blob]", error);
    return null;
  });
  if (!blobRes || blobRes.statusCode !== 200) {
    return new NextResponse("Failed to read blob", { status: 502 });
  }

  return new NextResponse(blobRes.stream, {
    headers: safeAssetHeaders(name, mimeType || blobRes.blob.contentType, blobRes.blob.size || size),
  });
}

export async function GET(_: Request, { params }: Context) {
  const { slug, assetId } = await params;

  const space = await prisma.space.findUnique({ where: { slug } });
  if (!space) {
    return new NextResponse("Space not found", { status: 404 });
  }

  if (!(await canReadSpace(space))) {
    return new NextResponse("Read permission required", { status: 401 });
  }

  const asset = await prisma.asset.findFirst({
    where: { id: assetId, spaceId: space.id },
  });

  if (!asset) {
    return new NextResponse("Asset not found", { status: 404 });
  }

  if (asset.storage === "blob" && asset.blobUrl) {
    if (!parseTrustedBlobUrl(asset.blobUrl)) {
      return new NextResponse("Invalid Blob URL", { status: 502 });
    }

    // 权限校验通过后签发短时效直链并 302 重定向，浏览器直接从 Blob CDN 下载，
    // 文件字节不再经过 serverless 函数中转，大文件下载明显更快
    const presignedUrl = await presignBlobDownloadUrl(asset.blobUrl);
    if (presignedUrl) {
      // Vercel's download=1 keeps active content off the page while preserving
      // the direct CDN path for large files.
      return NextResponse.redirect(assetRedirectUrl(presignedUrl, asset.mimeType), {
        status: 302,
        headers: {
          "Cache-Control": "private, no-store",
        },
      });
    }

    // 签名直链不可用时回退到代理下载
    return proxyBlobDownload(asset.blobUrl, asset.name, asset.mimeType, asset.size);
  }

  if (!asset.data) {
    return new NextResponse("Asset payload missing", { status: 404 });
  }

  let payload: Buffer;
  try {
    payload = decryptBytes(asset.data);
  } catch (error) {
    console.error("[asset-download:decrypt]", error);
    return new NextResponse("Asset decryption failed", { status: 500 });
  }

  return new NextResponse(new Uint8Array(payload), {
    headers: safeAssetHeaders(asset.name, asset.mimeType, payload.length),
  });
}

export async function DELETE(_: Request, { params }: Context) {
  const { slug, assetId } = await params;
  const space = await prisma.space.findUnique({ where: { slug } });
  if (!space) {
    return new NextResponse("Space not found", { status: 404 });
  }

  if (!(await canWriteSpace(space))) {
    return new NextResponse("Write permission required", { status: 401 });
  }

  const target = await prisma.asset.findFirst({
    where: { id: assetId, spaceId: space.id },
    select: { id: true, blobUrl: true, storage: true },
  });

  if (!target) {
    return new NextResponse("Asset not found", { status: 404 });
  }

  if (target.storage === "blob" && target.blobUrl) {
    const trustedUrl = parseTrustedBlobUrl(target.blobUrl);
    if (!trustedUrl) {
      return new NextResponse("Invalid Blob URL", { status: 502 });
    }
    try {
      await del(trustedUrl.toString());
    } catch {
      return new NextResponse("Failed to remove blob", { status: 500 });
    }
  }

  const deleted = await prisma.asset.deleteMany({
    where: { id: assetId, spaceId: space.id },
  });

  if (deleted.count === 0) {
    return new NextResponse("Asset not found", { status: 404 });
  }

  await writeAudit({
    action: "asset_delete",
    actor: "space",
    ip: await getClientIp(),
    spaceId: space.id,
    detail: assetId,
  });

  return NextResponse.json({ ok: true });
}
