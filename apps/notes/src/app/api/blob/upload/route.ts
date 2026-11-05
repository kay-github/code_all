import { NextResponse } from "next/server";
import { handleUpload, type HandleUploadBody } from "@vercel/blob/client";
import { del, head } from "@vercel/blob";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { MAX_FILE_SIZE } from "@/lib/config";
import { prisma } from "@/lib/prisma";
import { canWriteSpace } from "@/lib/space-permission";
import { getClientIp } from "@/lib/request";
import { checkRateLimit } from "@/lib/ratelimit";
import { blobAssetId, parseTrustedBlobUrl } from "@/lib/blob-security";

const payloadSchema = z.object({
  slug: z.string().min(1),
  originalName: z
    .string()
    .min(1)
    .max(255)
    .refine((name) => !/[\\/\0\r\n]/.test(name), "Invalid file name"),
  mimeType: z.string().min(1).max(120),
  size: z.number().int().nonnegative(),
});

const tokenPayloadSchema = payloadSchema.extend({
  spaceId: z.string().min(1),
  ip: z.string().min(1).max(255),
});

export async function POST(request: Request): Promise<NextResponse> {
  const ip = await getClientIp();

  try {
    const body = (await request.json()) as HandleUploadBody;
    if (
      body.type === "blob.generate-client-token" &&
      !(await checkRateLimit(`blob-upload:${ip}`, 60, 5 * 60 * 1000))
    ) {
      return new NextResponse("Too many requests", { status: 429 });
    }

    const jsonResponse = await handleUpload({
      body,
      request,
      onBeforeGenerateToken: async (pathname, clientPayload) => {
        const parsed = payloadSchema.safeParse(JSON.parse(clientPayload || "{}"));
        if (!parsed.success) {
          throw new Error("Invalid upload payload");
        }

        if (parsed.data.size > MAX_FILE_SIZE) {
          throw new Error("File too large, max 50MB");
        }

        if (pathname !== parsed.data.originalName) {
          throw new Error("Upload pathname does not match file name");
        }

        const space = await prisma.space.findUnique({ where: { slug: parsed.data.slug } });
        if (!space || !(await canWriteSpace(space))) {
          throw new Error("Write permission required");
        }

        return {
          access: "private",
          addRandomSuffix: true,
          maximumSizeInBytes: MAX_FILE_SIZE,
          allowedContentTypes: [parsed.data.mimeType],
          validUntil: Date.now() + 10 * 60 * 1000,
          tokenPayload: JSON.stringify({ ...parsed.data, spaceId: space.id, ip }),
        };
      },
      onUploadCompleted: async ({ blob, tokenPayload }) => {
        const parsed = tokenPayloadSchema.safeParse(JSON.parse(tokenPayload || "{}"));
        if (!parsed.success || !parseTrustedBlobUrl(blob.url)) {
          throw new Error("Invalid completed upload payload");
        }

        const space = await prisma.space.findUnique({
          where: { id: parsed.data.spaceId },
          select: { id: true, slug: true },
        });
        if (!space || space.slug !== parsed.data.slug) {
          await del(blob.url).catch((error) => console.error("[blob-upload:cleanup-missing-space]", error));
          return;
        }

        const metadata = await head(blob.url);
        if (metadata.size > MAX_FILE_SIZE || metadata.size !== parsed.data.size) {
          await del(blob.url).catch((error) => console.error("[blob-upload:cleanup-invalid-size]", error));
          return;
        }

        const id = blobAssetId(blob.url);
        try {
          await prisma.asset.create({
            data: {
              id,
              spaceId: space.id,
              name: parsed.data.originalName,
              mimeType: metadata.contentType || parsed.data.mimeType,
              size: metadata.size,
              blobUrl: blob.url,
              storage: "blob",
            },
          });
        } catch (error) {
          if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
            const existing = await prisma.asset.findUnique({ where: { id }, select: { blobUrl: true, spaceId: true } });
            if (existing?.blobUrl === blob.url && existing.spaceId === space.id) {
              return;
            }
          }
          throw error;
        }

        await prisma.auditLog
          .create({
            data: {
              action: "asset_upload_blob",
              actor: "space",
              ip: parsed.data.ip,
              spaceId: space.id,
              detail: parsed.data.originalName,
            },
          })
          .catch((error) => console.error("[blob-upload:audit]", error));
      },
    });

    return NextResponse.json(jsonResponse);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Upload token generation failed";
    console.error("[blob-upload]", message);
    return new NextResponse(message, { status: 400 });
  }
}
