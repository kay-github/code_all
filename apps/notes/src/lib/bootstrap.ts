import { prisma } from "@/lib/prisma";
import { APP_CONFIG } from "@/lib/config";
import { encryptText } from "@/lib/crypto";
import { Prisma } from "@prisma/client";

export async function ensureDefaultSpace(): Promise<void> {
  const existing = await prisma.space.findUnique({
    where: { slug: APP_CONFIG.defaultSpaceSlug },
    select: { id: true },
  });

  if (existing) {
    return;
  }

  try {
    await prisma.space.create({
      data: {
        slug: APP_CONFIG.defaultSpaceSlug,
        title: APP_CONFIG.defaultSpaceTitle,
        note: { create: { content: encryptText("欢迎使用免登录临时笔记本。") } },
      },
    });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      return;
    }
    throw error;
  }
}
