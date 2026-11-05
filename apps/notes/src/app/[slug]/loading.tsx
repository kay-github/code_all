export default function Loading() {
  return (
    <main className="mx-auto w-full max-w-5xl px-4 py-6 sm:px-6 lg:px-8">
      <div className="mb-4">
        <div className="h-9 w-24 animate-pulse rounded-[10px] border border-[var(--line)] bg-white" />
      </div>
      <section className="space-y-4">
        <div className="panel h-28 animate-pulse p-5" />
        <div className="panel h-80 animate-pulse p-4" />
        <div className="panel h-32 animate-pulse p-4" />
      </section>
    </main>
  );
}
