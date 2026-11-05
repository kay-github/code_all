import Link from "next/link";
import { isAdminAuthed } from "@/lib/auth";
import { ensureDefaultSpace } from "@/lib/bootstrap";
import { APP_CONFIG } from "@/lib/config";
import { prisma } from "@/lib/prisma";
import { AdminPanel } from "@/components/admin-panel";

export const dynamic = "force-dynamic";

export default async function AdminPage() {
  await ensureDefaultSpace();
  const authed = await isAdminAuthed();

  const spaces = await prisma.space.findMany({
    orderBy: { createdAt: "asc" },
    include: {
      note: { select: { updatedAt: true } },
      assets: { select: { id: true } },
    },
  });

  const orderedSpaces = [...spaces].sort((a, b) => {
    const aPublic = a.slug === APP_CONFIG.defaultSpaceSlug;
    const bPublic = b.slug === APP_CONFIG.defaultSpaceSlug;
    if (aPublic && !bPublic) return -1;
    if (!aPublic && bPublic) return 1;
    return 0;
  });

  return (
    <main className="mx-auto w-full max-w-5xl px-4 py-6 sm:px-6 lg:px-8">
      <div className="mb-4 flex items-center justify-between">
        <Link className="btn btn-ghost" href="/">
          返回首页
        </Link>
      </div>

      <AdminPanel
        authed={authed}
        spaces={orderedSpaces.map((space) => ({
          id: space.id,
          title: space.title,
          slug: space.slug,
          isPublic: space.slug === APP_CONFIG.defaultSpaceSlug,
          hasPassword: Boolean(space.passwordHash),
          assetCount: space.assets.length,
          updatedAt: new Date(space.note?.updatedAt || space.updatedAt).toISOString(),
        }))}
      />
    </main>
  );
}
