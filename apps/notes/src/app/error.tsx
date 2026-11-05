"use client";

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <main className="mx-auto flex min-h-screen w-full max-w-3xl items-center px-4 py-10 sm:px-6">
      <section className="panel w-full p-6">
        <h1 className="text-2xl font-semibold">服务暂时不可用</h1>
        <p className="mt-2 text-sm text-[var(--ink-1)]">
          可能是数据库连接或数据库表未初始化。请确认 Vercel 环境变量 `DATABASE_URL` 已配置，并可访问。
        </p>
        {error.digest && (
          <p className="mt-2 font-mono text-xs text-[var(--ink-1)]">Digest: {error.digest}</p>
        )}
        <button className="btn btn-primary mt-4" onClick={reset} type="button">
          重试
        </button>
      </section>
    </main>
  );
}
