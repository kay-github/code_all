import { prisma } from "@/lib/prisma";

type NoteStore = {
  upsert(args: unknown): Promise<{ updatedAt: Date }>;
  create(args: unknown): Promise<{ updatedAt: Date }>;
  updateManyAndReturn(args: unknown): Promise<Array<{ updatedAt: Date }>>;
};

type SaveNoteInput = {
  spaceId: string;
  encryptedContent: string;
  baseUpdatedAt: Date | null;
  force: boolean;
};

function isUniqueConstraintError(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "P2002");
}

export async function saveNoteAtomically(
  input: SaveNoteInput,
  store: NoteStore = prisma.note as unknown as NoteStore,
): Promise<Date | null> {
  if (input.force) {
    const saved = await store.upsert({
      where: { spaceId: input.spaceId },
      create: { spaceId: input.spaceId, content: input.encryptedContent },
      update: { content: input.encryptedContent },
      select: { updatedAt: true },
    });
    return saved.updatedAt;
  }

  if (input.baseUpdatedAt === null) {
    try {
      const saved = await store.create({
        data: { spaceId: input.spaceId, content: input.encryptedContent },
        select: { updatedAt: true },
      });
      return saved.updatedAt;
    } catch (error) {
      if (isUniqueConstraintError(error)) return null;
      throw error;
    }
  }

  const updated = await store.updateManyAndReturn({
    where: { spaceId: input.spaceId, updatedAt: input.baseUpdatedAt },
    data: { content: input.encryptedContent },
    select: { updatedAt: true },
  });
  return updated.length === 1 ? updated[0].updatedAt : null;
}
