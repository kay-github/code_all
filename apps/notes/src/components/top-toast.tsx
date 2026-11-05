"use client";

import { useEffect } from "react";

type ToastTone = "success" | "error" | "info";

type Props = {
  message: string;
  tone?: ToastTone;
  onClose: () => void;
  durationMs?: number;
};

const toneMap: Record<ToastTone, string> = {
  success: "border-[#2a8a72] bg-[#e7f8f3] text-[#165949]",
  error: "border-[#c0493d] bg-[#fff0ed] text-[#6c231d]",
  info: "border-[#376aa8] bg-[#eef5ff] text-[#1f3f66]",
};

export function TopToast({ message, tone = "info", onClose, durationMs = 2600 }: Props) {
  useEffect(() => {
    const timer = window.setTimeout(() => onClose(), durationMs);
    return () => window.clearTimeout(timer);
  }, [durationMs, message, onClose]);

  return (
    <div className="pointer-events-none fixed left-1/2 top-4 z-50 -translate-x-1/2 px-4">
      <div
        className={`min-w-56 rounded-xl border px-4 py-2 text-center text-sm font-medium shadow-xl ${toneMap[tone]}`}
        role="status"
      >
        {message}
      </div>
    </div>
  );
}

export type { ToastTone };
