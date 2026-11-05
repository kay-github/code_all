"use client";

import { useEffect, useState } from "react";
import Image from "next/image";

// 当前空间链接的二维码，方便手机和电脑之间扫码打开；生成库按需动态加载
export function SpaceQr() {
  const [open, setOpen] = useState(false);
  const [dataUrl, setDataUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!open || dataUrl || failed) {
      return;
    }
    let cancelled = false;
    import("qrcode-generator")
      .then((mod) => {
        const qr = mod.default(0, "M");
        qr.addData(window.location.href);
        qr.make();
        return qr.createDataURL(4, 8);
      })
      .then((url) => {
        if (!cancelled) {
          setDataUrl(url);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setFailed(true);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [open, dataUrl, failed]);

  return (
    <div className="flex flex-col items-end gap-2">
      <button className="btn btn-ghost" onClick={() => setOpen((v) => !v)} type="button">
        {open ? "收起二维码" : "扫码打开"}
      </button>
      {open && (
        <div className="rounded-xl border border-[var(--line)] bg-white p-2">
          {dataUrl ? (
            <Image alt="当前空间链接二维码" height={160} src={dataUrl} unoptimized width={160} />
          ) : (
            <p className="p-4 text-xs text-[var(--ink-1)]">{failed ? "二维码生成失败" : "生成中…"}</p>
          )}
        </div>
      )}
    </div>
  );
}
