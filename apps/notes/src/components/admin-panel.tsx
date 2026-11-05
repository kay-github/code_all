"use client";

import { notesApi } from "@/lib/paths";

import { FormEvent, useCallback, useState } from "react";
import { useRouter } from "next/navigation";
import { TopToast, ToastTone } from "@/components/top-toast";

type SpaceInfo = {
  id: string;
  title: string;
  slug: string;
  isPublic: boolean;
  hasPassword: boolean;
  assetCount: number;
  updatedAt: string;
};

type Props = {
  authed: boolean;
  spaces: SpaceInfo[];
};

export function AdminPanel({ authed, spaces }: Props) {
  const router = useRouter();
  const [adminPwd, setAdminPwd] = useState("");
  const [toast, setToast] = useState<{ message: string; tone: ToastTone } | null>(null);
  const [title, setTitle] = useState("");
  const [slug, setSlug] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);

  const notify = useCallback((message: string, tone: ToastTone = "info") => {
    setToast({ message, tone });
  }, []);

  async function unlockAdmin(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      const res = await fetch(notesApi("admin/unlock"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password: adminPwd }),
      });
      if (!res.ok) {
        throw new Error("超管密码错误");
      }
      notify("超管验证成功", "success");
      setAdminPwd("");
      router.refresh();
    } catch (error) {
      notify(error instanceof Error ? error.message : "验证失败", "error");
    } finally {
      setBusy(false);
    }
  }

  async function createSpace(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      const res = await fetch(notesApi("admin/spaces"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title, slug, password }),
      });
      if (!res.ok) {
        const text = await res.text();
        throw new Error(text || "创建失败");
      }
      setTitle("");
      setSlug("");
      setPassword("");
      notify("空间创建成功", "success");
      router.refresh();
    } catch (error) {
      notify(error instanceof Error ? error.message : "创建失败", "error");
    } finally {
      setBusy(false);
    }
  }

  async function updateSpace(spaceId: string, patch: Record<string, string>) {
    setBusy(true);
    try {
      const res = await fetch(notesApi("admin/spaces"), {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ spaceId, ...patch }),
      });
      if (!res.ok) {
        const text = await res.text();
        throw new Error(text || "更新失败");
      }
      notify("空间设置已更新", "success");
      router.refresh();
    } catch (error) {
      notify(error instanceof Error ? error.message : "更新失败", "error");
    } finally {
      setBusy(false);
    }
  }

  async function removeSpace(spaceId: string) {
    if (!confirm("删除后不可恢复，确认继续？")) {
      return;
    }

    setBusy(true);
    try {
      const res = await fetch(notesApi("admin/spaces"), {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ spaceId }),
      });
      if (!res.ok) {
        const text = await res.text();
        throw new Error(text || "删除失败");
      }
      notify("空间已删除", "success");
      router.refresh();
    } catch (error) {
      notify(error instanceof Error ? error.message : "删除失败", "error");
    } finally {
      setBusy(false);
    }
  }

  async function logout() {
    await fetch(notesApi("admin/logout"), { method: "POST" });
    notify("已退出超管", "info");
    router.refresh();
  }

  if (!authed) {
    return (
      <>
        {toast && <TopToast message={toast.message} onClose={() => setToast(null)} tone={toast.tone} />}
        <section className="panel p-6">
          <h1 className="text-2xl font-semibold">管理台</h1>
          <p className="mt-2 text-sm text-[var(--ink-1)]">输入超管密码后可创建空间、修改路径和密码。</p>
          <form className="mt-4 flex flex-col gap-3 sm:flex-row" onSubmit={unlockAdmin}>
            <input
              className="field"
              onChange={(e) => setAdminPwd(e.target.value)}
              placeholder="输入超管密码"
              type="password"
              value={adminPwd}
            />
            <button className="btn btn-primary" disabled={busy} type="submit">
              验证
            </button>
          </form>
        </section>
      </>
    );
  }

  return (
    <section className="space-y-4">
      {toast && <TopToast message={toast.message} onClose={() => setToast(null)} tone={toast.tone} />}

      <header className="panel p-6">
        <div className="flex items-center justify-between">
          <h1 className="text-2xl font-semibold">管理台</h1>
          <button className="btn btn-ghost" onClick={logout} type="button">
            退出超管
          </button>
        </div>
        <p className="mt-2 text-sm text-[var(--ink-1)]">已验证超管密码，可免密进入并管理所有空间。</p>
      </header>

      <form className="panel grid gap-3 p-4 sm:grid-cols-4" onSubmit={createSpace}>
        <input
          className="field"
          onChange={(e) => setTitle(e.target.value)}
          placeholder="空间标题"
          value={title}
        />
        <input
          className="field font-mono"
          onChange={(e) => setSlug(e.target.value)}
          placeholder="路径 slug"
          value={slug}
        />
        <input
          className="field"
          onChange={(e) => setPassword(e.target.value)}
          placeholder="空间密码（必填）"
          type="text"
          value={password}
          required
        />
        <button className="btn btn-primary" disabled={busy} type="submit">
          创建空间
        </button>
      </form>

      <div className="space-y-3">
        {spaces.map((space) => (
          <div className="panel p-4" key={space.id}>
            <div className="flex items-center justify-between gap-2">
              <p className="text-lg font-semibold">{space.title}</p>
              {space.isPublic && (
                <span className="rounded-full bg-[var(--brand-soft)] px-2.5 py-1 text-xs font-semibold text-[var(--brand)]">
                  公共空间
                </span>
              )}
            </div>
            <p className="font-mono text-xs text-[var(--ink-1)]">/{space.slug}</p>
            <p className="mt-1 text-xs text-[var(--ink-1)]">
              附件 {space.assetCount} 个 · 最近更新 {new Date(space.updatedAt).toLocaleString("zh-CN")}
            </p>
            <div className="mt-3 grid gap-2 sm:grid-cols-4">
              <button
                className="btn btn-ghost"
                onClick={() => {
                  const value = prompt("输入新标题", space.title);
                  if (value) {
                    updateSpace(space.id, { title: value });
                  }
                }}
                type="button"
              >
                改标题
              </button>
              <button
                className="btn btn-ghost"
                onClick={() => {
                  const value = prompt("输入新路径（仅字母数字-_）", space.slug);
                  if (value) {
                    updateSpace(space.id, { slug: value });
                  }
                }}
                type="button"
              >
                改路径
              </button>
              <button
                className="btn btn-ghost"
                onClick={() => {
                  const value = prompt("输入新密码", "");
                  if (value && value.trim()) {
                    updateSpace(space.id, { password: value });
                  }
                }}
                type="button"
              >
                {space.hasPassword ? "改密码" : "设密码"}
              </button>
              <button className="btn btn-danger" onClick={() => removeSpace(space.id)} type="button">
                删除空间
              </button>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
