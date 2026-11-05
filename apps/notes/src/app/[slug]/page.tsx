import { notFound } from "next/navigation";
import { ensureDefaultSpace } from "@/lib/bootstrap";
import { APP_CONFIG } from "@/lib/config";
import { prisma } from "@/lib/prisma";
import { SpaceView } from "@/components/space-view";
import { canReadSpace, canWriteSpace } from "@/lib/space-permission";
import { decryptText } from "@/lib/crypto";

export const dynamic = "force-dynamic";

type Props = {
  params: Promise<{ slug: string }>;
};

export default async function SpacePage({ params }: Props) {
  const { slug } = await params;

  const querySpace = () =>
    prisma.space.findUnique({
      where: { slug },
      include: {
        note: true,
        assets: {
          orderBy: { createdAt: "desc" },
          // 只取元数据，避免把加密后的文件二进制（最大 50MB/个）一并读出拖慢页面
          select: { id: true, name: true, mimeType: true, size: true, createdAt: true },
        },
      },
    });

  let space = await querySpace();

  // 仅当访问的是默认公共空间且尚未创建时才补建，避免每次访问都多一次数据库往返
  if (!space && slug === APP_CONFIG.defaultSpaceSlug) {
    await ensureDefaultSpace();
    space = await querySpace();
  }

  if (!space) {
    notFound();
  }

  const isPublicSpace = space.slug === APP_CONFIG.defaultSpaceSlug;
  const [canRead, canWrite] = await Promise.all([canReadSpace(space), canWriteSpace(space)]);

  return (
    <main className="mx-auto w-full max-w-5xl px-4 py-6 sm:px-6 lg:px-8">
      <SpaceView
        slug={space.slug}
        title={space.title}
        note={canRead ? decryptText(space.note?.content || "") : ""}
        noteUpdatedAt={canRead ? (space.note?.updatedAt.toISOString() ?? null) : null}
        canRead={canRead}
        canWrite={canWrite}
        hasPassword={Boolean(space.passwordHash)}
        requiresEntryPassword={!isPublicSpace}
        isPublicSpace={isPublicSpace}
        assets={
          canRead
            ? space.assets.map((asset) => ({
                id: asset.id,
                name: asset.name,
                mimeType: asset.mimeType,
                size: asset.size,
                createdAt: asset.createdAt.toISOString(),
              }))
            : []
        }
      />
    </main>
  );
}
