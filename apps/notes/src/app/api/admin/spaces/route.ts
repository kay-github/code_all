import { NextResponse } from "next/server";
import { del } from "@vercel/blob";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { APP_CONFIG } from "@/lib/config";
import { isAdminAuthed } from "@/lib/auth";
import { hashPassword } from "@/lib/hash";
import { prisma } from "@/lib/prisma";
import { writeAudit } from "@/lib/audit";
import { getClientIp } from "@/lib/request";
import { encryptText } from "@/lib/crypto";
import { parseTrustedBlobUrl } from "@/lib/blob-security";

const slugPattern = /^[a-zA-Z0-9_-]{3,30}$/;

const createSchema = z.object({
  title: z.string().trim().min(1).max(60),
  slug: z.string().trim().regex(slugPattern),
  password: z.string().trim().min(1).max(40),
});

const updateSchema = z.object({
  spaceId: z.string().min(1),
  title: z.string().trim().min(1).max(60).optional(),
  slug: z.string().trim().regex(slugPattern).optional(),
  password: z.string().trim().min(1).max(40).optional(),
});

const deleteSchema = z.object({
  spaceId: z.string().min(1),
});

async function ensureAdmin() {
  if (!(await isAdminAuthed())) {
    return new NextResponse("Admin auth required", { status: 401 });
  }
  return null;
}

export async function POST(req: Request) {
  const denied = await ensureAdmin();
  if (denied) return denied;

  const ip = await getClientIp();
  const parsed = createSchema.safeParse(await req.json());
  if (!parsed.success) {
    return new NextResponse("Invalid payload", { status: 400 });
  }

  const payload = parsed.data;
  const passwordHash = await hashPassword(payload.password);

  try {
    const space = await prisma.space.create({
      data: {
        title: payload.title,
        slug: payload.slug,
        passwordHash,
        note: { create: { content: encryptText("") } },
      },
    });

    await writeAudit({
      action: "admin_create_space",
      actor: "admin",
      ip,
      spaceId: space.id,
      detail: payload.slug,
    });

    return NextResponse.json({ ok: true, spaceId: space.id });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      return new NextResponse("路径已被占用", { status: 409 });
    }
    return new NextResponse("Failed to create space", { status: 500 });
  }
}

export async function PATCH(req: Request) {
  const denied = await ensureAdmin();
  if (denied) return denied;

  const ip = await getClientIp();
  const parsed = updateSchema.safeParse(await req.json());
  if (!parsed.success) {
    return new NextResponse("Invalid payload", { status: 400 });
  }

  const payload = parsed.data;
  const updateData: Prisma.SpaceUpdateInput = {};

  if (payload.title !== undefined) updateData.title = payload.title;
  if (payload.slug !== undefined) updateData.slug = payload.slug;
  if (payload.password !== undefined) {
    updateData.passwordHash = await hashPassword(payload.password);
  }

  if (Object.keys(updateData).length === 0) {
    return new NextResponse("No changes", { status: 400 });
  }

  try {
    const space = await prisma.space.update({
      where: { id: payload.spaceId },
      data: updateData,
      select: { id: true },
    });

    await writeAudit({
      action: "admin_update_space",
      actor: "admin",
      ip,
      spaceId: space.id,
    });

    return NextResponse.json({ ok: true });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      return new NextResponse("路径已被占用", { status: 409 });
    }
    return new NextResponse("Failed to update space", { status: 500 });
  }
}

export async function DELETE(req: Request) {
  const denied = await ensureAdmin();
  if (denied) return denied;

  const ip = await getClientIp();
  const parsed = deleteSchema.safeParse(await req.json());
  if (!parsed.success) {
    return new NextResponse("Invalid payload", { status: 400 });
  }

  const target = await prisma.space.findUnique({
    where: { id: parsed.data.spaceId },
    select: {
      slug: true,
      id: true,
      assets: {
        where: { storage: "blob", blobUrl: { not: null } },
        select: { blobUrl: true },
      },
    },
  });

  if (!target) {
    return new NextResponse("Space not found", { status: 404 });
  }

  if (target.slug === APP_CONFIG.defaultSpaceSlug) {
    return new NextResponse("默认空间不可删除", { status: 400 });
  }

  // 先删 Blob 文件再删数据库，否则级联删除 Asset 行后文件成为孤儿，永久占用存储额度
  const blobUrls = target.assets
    .map((asset) => asset.blobUrl)
    .filter((url): url is string => Boolean(url))
    .map((url) => parseTrustedBlobUrl(url)?.toString())
    .filter((url): url is string => Boolean(url));
  if (blobUrls.length > 0) {
    try {
      await del(blobUrls);
    } catch (error) {
      console.error("[admin-delete-space:blob]", error);
      return new NextResponse("删除空间附件失败，请重试", { status: 502 });
    }
  }

  await prisma.space.delete({ where: { id: target.id } });
  // 空间行已删除，审计不能再引用 spaceId（外键会失败），slug 记录在 detail 中
  await writeAudit({
    action: "admin_delete_space",
    actor: "admin",
    ip,
    detail: target.slug,
  });

  return NextResponse.json({ ok: true });
}
