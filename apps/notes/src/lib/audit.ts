import { after } from "next/server";
import { prisma } from "@/lib/prisma";

type AuditInput = {
  action: string;
  actor: "visitor" | "space" | "admin";
  ip: string;
  spaceId?: string;
  detail?: string;
};

export async function writeAudit(input: AuditInput): Promise<void> {
  // 审计写入放到响应返回之后执行，不阻塞用户请求
  after(async () => {
    try {
      await prisma.auditLog.create({
        data: {
          action: input.action,
          actor: input.actor,
          ip: input.ip,
          spaceId: input.spaceId,
          detail: input.detail,
        },
      });
    } catch (error) {
      console.error("[writeAudit]", error);
    }
  });
}
