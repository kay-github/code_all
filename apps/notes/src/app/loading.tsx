export default function Loading() {
  return (
    <main className="mx-auto w-full max-w-5xl px-4 py-6 sm:px-6 lg:px-8">
      <div className="panel mb-5 h-28 animate-pulse p-5" />
      <section className="grid gap-4 sm:grid-cols-2">
        {[0, 1, 2, 3].map((i) => (
          <div className="panel h-44 animate-pulse" key={i} />
        ))}
      </section>
    </main>
  );
}
