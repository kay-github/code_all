import { NextResponse } from "next/server";
import { MAX_FILE_SIZE } from "@/lib/config";
import { canWriteSpace } from "@/lib/space-permission";
import { prisma } from "@/lib/prisma";
import { getClientIp } from "@/lib/request";
import { writeAudit } from "@/lib/audit";
import { encryptBytes } from "@/lib/crypto";
import { checkRateLimit } from "@/lib/ratelimit";

type Context = { params: Promise<{ slug: string }> };

export async function POST(req: Request, { params }: Context) {
  const { slug } = await params;

  const space = await prisma.space.findUnique({ where: { slug } });
  if (!space) {
    return new NextResponse("Space not found", { status: 404 });
  }

  if (!(await canWriteSpace(space))) {
    return new NextResponse("Write permission required", { status: 401 });
  }

  const ip = await getClientIp();
  if (!(await checkRateLimit(`db-upload:${ip}:${slug}`, 30, 5 * 60 * 1000))) {
    return new NextResponse("Too many requests", { status: 429 });
  }

  const form = await req.formData();
  const file = form.get("file");
  if (!(file instanceof File)) {
    return new NextResponse("No file", { status: 400 });
  }

  if (file.size > MAX_FILE_SIZE) {
    return new NextResponse("File too large, max 50MB", { status: 400 });
  }

  const bytes = new Uint8Array(await file.arrayBuffer());
  const encrypted = encryptBytes(bytes);
  const asset = await prisma.asset.create({
    data: {
      spaceId: space.id,
      name: file.name,
      mimeType: file.type || "application/octet-stream",
      size: file.size,
      data: Uint8Array.from(encrypted),
    },
  });

  await writeAudit({
    action: "asset_upload",
    actor: "space",
    ip,
    spaceId: space.id,
    detail: file.name,
  });

  return NextResponse.json({ ok: true, assetId: asset.id });
}
