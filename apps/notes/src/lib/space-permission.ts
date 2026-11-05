import { canWriteWithSpaceCookie, isAdminAuthed } from "@/lib/auth";
import { Space } from "@prisma/client";
import { APP_CONFIG } from "@/lib/config";

export async function canReadSpace(space: Space): Promise<boolean> {
  if (await isAdminAuthed()) {
    return true;
  }

  if (space.slug === APP_CONFIG.defaultSpaceSlug) {
    return true;
  }

  return canWriteWithSpaceCookie(space.slug, space.passwordHash);
}

export async function canWriteSpace(space: Space): Promise<boolean> {
  if (await isAdminAuthed()) {
    return true;
  }

  return canWriteWithSpaceCookie(space.slug, space.passwordHash);
}
