export default function NotFound() {
  return (
    <main className="flex min-h-screen items-center justify-center px-6">
      <div className="max-w-md text-center">
        <p className="text-sm font-semibold uppercase tracking-[0.22em] text-orange-200/75">
          404
        </p>
        <h1 className="mt-4 text-4xl font-semibold tracking-[-0.04em] text-white">
          Page not found
        </h1>
        <p className="mt-4 text-base leading-7 text-slate-300">
          This AgentReview page does not exist. Return home and load a review from
          the CLI or from a pasted payload.
        </p>
        <a
          href="/"
          className="mt-8 inline-flex rounded-full border border-white/10 bg-white/5 px-4 py-2 text-sm text-white transition-colors hover:bg-white/10"
        >
          Go home
        </a>
      </div>
    </main>
  );
}
