import { PasteArea } from "@/components/PasteArea";
import { HomeWorkflow } from "@/components/HomeWorkflow";

export default function Home() {
  return (
    <main className="home-shell relative overflow-hidden">
      <div className="mx-auto flex min-h-screen w-full max-w-7xl flex-col px-6 py-10 sm:px-8 lg:px-10">
        <section className="mx-auto flex w-full max-w-4xl flex-col items-center pt-6 text-center">
          <div className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/5 px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.24em] text-orange-200/80">
            <span className="h-2 w-2 rounded-full bg-emerald-300 shadow-[0_0_14px_rgba(110,231,183,0.75)]" />
            No login. Paste and review.
          </div>
          <h1 className="mt-5 text-4xl font-semibold tracking-[-0.04em] text-white sm:text-5xl lg:text-6xl">
            Paste your AgentReview payload and start reviewing.
          </h1>
          <p className="mt-4 max-w-2xl text-base leading-7 text-slate-300 sm:text-lg">
            This is the fast path. Generate a payload from the CLI, paste it here,
            add inline comments, and export the feedback back to your agent.
          </p>

          <div className="home-panel mt-8 w-full rounded-[34px] p-6 text-left sm:p-7">
            <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
              <div>
                <p className="text-[11px] font-semibold uppercase tracking-[0.24em] text-orange-200/75">
                  Paste a Payload
                </p>
                <p className="mt-2 text-sm leading-6 text-slate-400">
                  The payload stays in your browser session. Paste it and go.
                </p>
              </div>
              <div className="rounded-full border border-white/10 bg-white/5 px-3 py-1.5 text-xs text-slate-300">
                <span className="font-mono text-cyan-100">agentreview | pbcopy</span>
              </div>
            </div>
            <PasteArea />
          </div>

          <a
            href="#guide"
            className="mt-5 inline-flex items-center gap-2 text-sm text-slate-400 transition-colors hover:text-white"
          >
            Confused? scroll further
            <span aria-hidden="true" className="text-base text-orange-200">
              ↓
            </span>
          </a>
        </section>

        <div id="guide" className="mt-16 pb-10">
          <HomeWorkflow />
        </div>
      </div>
    </main>
  );
}
