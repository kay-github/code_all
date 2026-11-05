import { NextResponse } from "next/server";
import { z } from "zod";
import { APP_CONFIG } from "@/lib/config";
import { setAdminSession } from "@/lib/auth";
import { checkRateLimit } from "@/lib/ratelimit";
import { getClientIp } from "@/lib/request";
import { secureTextEqual } from "@/lib/hash";

const bodySchema = z.object({
  password: z.string().min(1),
});

export async function POST(req: Request) {
  const ip = await getClientIp();
  if (!(await checkRateLimit(`admin-unlock:${ip}`, 12, 5 * 60 * 1000))) {
    return new NextResponse("Too many requests", { status: 429 });
  }

  const parsed = bodySchema.safeParse(await req.json());
  if (!parsed.success) {
    return new NextResponse("Invalid payload", { status: 400 });
  }

  if (!secureTextEqual(parsed.data.password, APP_CONFIG.adminPassword)) {
    return new NextResponse("Wrong admin password", { status: 401 });
  }

  await setAdminSession();
  return NextResponse.json({ ok: true });
}
