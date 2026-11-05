import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { canReadSpace } from "@/lib/space-permission";
import { blobAssetId, parseTrustedBlobUrl } from "@/lib/blob-security";

const blobUrlSchema = z.string().url().refine((value) => Boolean(parseTrustedBlobUrl(value)));

type Context = { params: Promise<{ slug: string }> };

export async function GET(req: Request, { params }: Context) {
  const { slug } = await params;
  const parsed = blobUrlSchema.safeParse(new URL(req.url).searchParams.get("blobUrl"));
  if (!parsed.success) {
    return new NextResponse("Invalid Blob URL", { status: 400 });
  }

  const space = await prisma.space.findUnique({ where: { slug } });
  if (!space) {
    return new NextResponse("Space not found", { status: 404 });
  }

  if (!(await canReadSpace(space))) {
    return new NextResponse("Read permission required", { status: 401 });
  }

  const asset = await prisma.asset.findFirst({
    where: { id: blobAssetId(parsed.data), spaceId: space.id, blobUrl: parsed.data },
    select: { id: true },
  });

  return NextResponse.json(
    { registered: Boolean(asset) },
    { headers: { "Cache-Control": "no-store" } },
  );
}

export async function POST() {
  return new NextResponse("Client-side Blob registration is disabled", { status: 410 });
}
