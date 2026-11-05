import { NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { canReadSpace } from "@/lib/space-permission";

type Context = { params: Promise<{ slug: string }> };

// 轻量状态接口：客户端轮询用，只返回版本信息，不传内容
export async function GET(_: Request, { params }: Context) {
  const { slug } = await params;

  const space = await prisma.space.findUnique({
    where: { slug },
    include: {
      note: { select: { updatedAt: true } },
      _count: { select: { assets: true } },
      assets: {
        orderBy: { createdAt: "desc" },
        take: 1,
        select: { createdAt: true },
      },
    },
  });

  if (!space) {
    return new NextResponse("Space not found", { status: 404 });
  }

  if (!(await canReadSpace(space))) {
    return new NextResponse("Read permission required", { status: 401 });
  }

  return NextResponse.json(
    {
      noteUpdatedAt: space.note?.updatedAt.toISOString() ?? null,
      assetCount: space._count.assets,
      latestAssetAt: space.assets[0]?.createdAt.toISOString() ?? null,
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
