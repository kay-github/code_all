import { NextResponse } from "next/server";
import { z } from "zod";
import { MAX_NOTE_LENGTH } from "@/lib/config";
import { canWriteSpace } from "@/lib/space-permission";
import { prisma } from "@/lib/prisma";
import { getClientIp } from "@/lib/request";
import { writeAudit } from "@/lib/audit";
import { encryptText } from "@/lib/crypto";
import { saveNoteAtomically } from "@/lib/note-save";

const bodySchema = z.object({
  content: z.string().max(MAX_NOTE_LENGTH),
  baseUpdatedAt: z.string().datetime().nullable(),
  force: z.boolean().optional(),
});

type Context = { params: Promise<{ slug: string }> };

export async function PUT(req: Request, { params }: Context) {
  const { slug } = await params;
  const parsed = bodySchema.safeParse(await req.json());
  if (!parsed.success) {
    return new NextResponse("Invalid content", { status: 400 });
  }

  const space = await prisma.space.findUnique({ where: { slug } });
  if (!space) {
    return new NextResponse("Space not found", { status: 404 });
  }

  if (!(await canWriteSpace(space))) {
    return new NextResponse("Write permission required", { status: 401 });
  }

  const encryptedContent = encryptText(parsed.data.content);
  const savedUpdatedAt = await saveNoteAtomically({
    spaceId: space.id,
    encryptedContent,
    baseUpdatedAt: parsed.data.baseUpdatedAt ? new Date(parsed.data.baseUpdatedAt) : null,
    force: parsed.data.force ?? false,
  });
  if (!savedUpdatedAt) {
    return new NextResponse("Note was modified on another device", { status: 409 });
  }

  await writeAudit({
    action: "note_update",
    actor: "space",
    ip: await getClientIp(),
    spaceId: space.id,
  });

  return NextResponse.json({ ok: true, updatedAt: savedUpdatedAt.toISOString() });
}
