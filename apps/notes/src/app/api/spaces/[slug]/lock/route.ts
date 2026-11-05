import { NextResponse } from "next/server";
import { clearSpaceSession } from "@/lib/auth";

type Context = { params: Promise<{ slug: string }> };

export async function POST(_: Request, { params }: Context) {
  const { slug } = await params;
  await clearSpaceSession(slug);
  return NextResponse.json({ ok: true });
}
