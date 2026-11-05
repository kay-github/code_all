import { describe, expect, test } from "bun:test";
import { saveNoteAtomically } from "@/lib/note-save";

type Store = Parameters<typeof saveNoteAtomically>[1];

describe("atomic note saves", () => {
  test("allows only one writer to commit the same base version", async () => {
    let updatedAt = new Date("2026-08-16T00:00:00.000Z");
    let content = "initial";
    const store = {
      async upsert() {
        throw new Error("unexpected force save");
      },
      async create() {
        throw new Error("unexpected create");
      },
      async updateManyAndReturn(args: unknown) {
        const input = args as { where: { updatedAt: Date }; data: { content: string } };
        if (input.where.updatedAt.getTime() !== updatedAt.getTime()) return [];
        content = input.data.content;
        updatedAt = new Date(updatedAt.getTime() + 1);
        return [{ updatedAt }];
      },
    } satisfies Store;

    const baseUpdatedAt = new Date(updatedAt);
    const results = await Promise.all([
      saveNoteAtomically({ spaceId: "space", encryptedContent: "first", baseUpdatedAt, force: false }, store),
      saveNoteAtomically({ spaceId: "space", encryptedContent: "second", baseUpdatedAt, force: false }, store),
    ]);

    expect(results.filter(Boolean)).toHaveLength(1);
    expect(results.filter((result) => result === null)).toHaveLength(1);
    expect(["first", "second"]).toContain(content);
  });

  test("maps a concurrent first-create unique violation to a conflict", async () => {
    const store = {
      async upsert() {
        throw new Error("unexpected force save");
      },
      async create() {
        throw { code: "P2002" };
      },
      async updateManyAndReturn() {
        throw new Error("unexpected update");
      },
    } satisfies Store;

    await expect(
      saveNoteAtomically(
        { spaceId: "space", encryptedContent: "first", baseUpdatedAt: null, force: false },
        store,
      ),
    ).resolves.toBeNull();
  });
});
