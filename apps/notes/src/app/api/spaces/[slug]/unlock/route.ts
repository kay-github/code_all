import { NextResponse } from "next/server";
import { z } from "zod";
import { setSpaceSession } from "@/lib/auth";
import { verifyPassword } from "@/lib/hash";
import { prisma } from "@/lib/prisma";
import { getClientIp } from "@/lib/request";
import { checkRateLimit } from "@/lib/ratelimit";
import { writeAudit } from "@/lib/audit";

const bodySchema = z.object({
  password: z.string().min(1),
});

type Context = { params: Promise<{ slug: string }> };

export async function POST(req: Request, { params }: Context) {
  const { slug } = await params;
  const ip = await getClientIp();

  if (!(await checkRateLimit(`space-unlock:${ip}:${slug}`, 16, 5 * 60 * 1000))) {
    return new NextResponse("Too many requests", { status: 429 });
  }

  const parsed = bodySchema.safeParse(await req.json());
  if (!parsed.success) {
    return new NextResponse("Invalid payload", { status: 400 });
  }

  const space = await prisma.space.findUnique({ where: { slug } });
  if (!space) {
    return new NextResponse("Space not found", { status: 404 });
  }

  if (!space.passwordHash) {
    return new NextResponse("This space has no password", { status: 400 });
  }

  const ok = await verifyPassword(parsed.data.password, space.passwordHash);
  if (!ok) {
    await writeAudit({
      action: "space_unlock_fail",
      actor: "visitor",
      ip,
      spaceId: space.id,
    });
    return new NextResponse("Wrong password", { status: 401 });
  }

  await setSpaceSession(slug, space.passwordHash);
  await writeAudit({
    action: "space_unlock_ok",
    actor: "space",
    ip,
    spaceId: space.id,
  });

  return NextResponse.json({ ok: true });
}
