const QUICKSTART_STEPS = [
  {
    step: "1. Install the CLI",
    command: "pip install agentreview",
    detail: "Install once, then use it from any git or sl repository you want to review.",
  },
  {
    step: "2. Generate a payload",
    command: "agentreview | pbcopy",
    detail: "Copy a review payload straight to your clipboard so it is ready to paste here.",
  },
  {
    step: "3. Review and send it back",
    command: "Export comments back to your agent",
    detail: "Paste the payload, leave inline review comments, then export a clean handoff back to the agent.",
  },
];

function CommandCard({
  step,
  command,
  detail,
}: {
  step: string;
  command: string;
  detail: string;
}) {
  return (
    <div className="home-panel rounded-[28px] p-5">
      <p className="text-[11px] font-semibold uppercase tracking-[0.22em] text-orange-200/75">
        {step}
      </p>
      <div className="mt-4 rounded-2xl border border-white/10 bg-slate-950/75 px-4 py-3 shadow-[inset_0_1px_0_rgba(255,255,255,0.05)]">
        <code className="text-sm text-teal-200">{command}</code>
      </div>
      <p className="mt-3 text-sm leading-6 text-slate-300">{detail}</p>
    </div>
  );
}

export function HomeWorkflow() {
  return (
    <>
      <section className="grid gap-4 lg:grid-cols-3">
        {QUICKSTART_STEPS.map((item) => (
          <CommandCard key={item.step} {...item} />
        ))}
      </section>

      <section className="mt-12">
        <div className="mb-6 flex items-end justify-between gap-4">
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-[0.26em] text-orange-200/75">
              How It Works
            </p>
            <h2 className="mt-2 text-3xl font-semibold tracking-tight text-white sm:text-4xl">
              Generate it, review it, hand it back.
            </h2>
          </div>
          <p className="max-w-md text-sm leading-6 text-slate-400">
            The loop stays tight: create a payload from the CLI, review inline in
            the browser, then export focused comments back to your coding agent.
          </p>
        </div>

        <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_72px_minmax(0,1fr)_72px_minmax(0,1fr)]">
          <article className="home-panel home-float rounded-[30px] p-5">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <span className="h-2.5 w-2.5 rounded-full bg-rose-400/80" />
                <span className="h-2.5 w-2.5 rounded-full bg-amber-300/80" />
                <span className="h-2.5 w-2.5 rounded-full bg-emerald-400/80" />
              </div>
              <span className="rounded-full border border-white/10 bg-white/5 px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.22em] text-slate-400">
                Terminal
              </span>
            </div>
            <div className="mt-5 rounded-[24px] border border-white/10 bg-slate-950/75 p-4 text-sm text-slate-200 shadow-[inset_0_1px_0_rgba(255,255,255,0.05)]">
              <p className="font-mono text-orange-200">$ pip install agentreview</p>
              <p className="mt-1 font-mono text-orange-200">$ agentreview | pbcopy</p>
              <div className="mt-4 space-y-2">
                <div className="home-line h-2.5 w-[88%] rounded-full bg-slate-800" />
                <div className="home-line h-2.5 w-[74%] rounded-full bg-slate-800 [animation-delay:-0.5s]" />
                <div className="home-line h-2.5 w-[92%] rounded-full bg-slate-800 [animation-delay:-1s]" />
                <div className="home-line h-2.5 w-[67%] rounded-full bg-slate-800 [animation-delay:-1.5s]" />
              </div>
              <div className="home-scan mt-4 rounded-2xl border border-teal-400/20 bg-teal-400/10 px-3 py-2 font-mono text-[11px] text-teal-100">
                ===AGENTREVIEW:v1=== ... copied to clipboard
              </div>
            </div>
          </article>

          <div className="hidden items-center justify-center xl:flex">
            <div className="home-flow flex h-12 w-12 items-center justify-center rounded-full border border-white/10 bg-white/5 text-lg text-orange-200">
              →
            </div>
          </div>

          <article className="home-panel home-float rounded-[30px] p-5 [animation-delay:-1.8s]">
            <div className="flex items-center justify-between">
              <span className="rounded-full border border-white/10 bg-white/5 px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.22em] text-slate-400">
                Browser Review
              </span>
              <span className="text-[11px] font-medium text-slate-500">
                drag to comment on a range
              </span>
            </div>
            <div className="mt-5 overflow-hidden rounded-[24px] border border-white/10 bg-slate-950/75 shadow-[inset_0_1px_0_rgba(255,255,255,0.05)]">
              <div className="border-b border-white/10 px-4 py-3 text-xs text-slate-400">
                src/review.ts
              </div>
              <div className="relative space-y-1 p-4 font-mono text-xs">
                <div className="flex items-center gap-3 text-slate-500">
                  <span className="w-8 text-right">48</span>
                  <span className="w-8 text-right">48</span>
                  <span className="text-slate-400">const summary = buildPrompt(diff);</span>
                </div>
                <div className="home-selection flex items-center gap-3 rounded-lg bg-cyan-400/10 px-2 py-1 text-cyan-100">
                  <span className="w-8 text-right text-cyan-200">49</span>
                  <span className="w-8 text-right text-cyan-200">49</span>
                  <span>const selection = lines.slice(start, end);</span>
                </div>
                <div className="home-selection flex items-center gap-3 rounded-lg bg-cyan-400/10 px-2 py-1 text-cyan-100 [animation-delay:-0.8s]">
                  <span className="w-8 text-right text-cyan-200">50</span>
                  <span className="w-8 text-right text-cyan-200">50</span>
                  <span>return addInlineComment(selection, note);</span>
                </div>
                <div className="flex items-center gap-3 text-slate-500">
                  <span className="w-8 text-right">51</span>
                  <span className="w-8 text-right">51</span>
                  <span className="text-slate-400">{"}"}</span>
                </div>
                <div className="home-comment absolute right-4 top-20 max-w-[14rem] rounded-2xl border border-orange-300/20 bg-orange-300/10 px-3 py-2 text-[11px] leading-5 text-orange-50 shadow-[0_16px_40px_rgba(249,115,22,0.14)]">
                  Handle multi-line selections the same way GitHub range comments
                  do, then export the whole note back to the agent.
                </div>
              </div>
            </div>
          </article>

          <div className="hidden items-center justify-center xl:flex">
            <div className="home-flow flex h-12 w-12 items-center justify-center rounded-full border border-white/10 bg-white/5 text-lg text-orange-200 [animation-delay:-1.2s]">
              →
            </div>
          </div>

          <article className="home-panel home-float rounded-[30px] p-5 [animation-delay:-3.2s]">
            <div className="flex items-center justify-between">
              <span className="rounded-full border border-white/10 bg-white/5 px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.22em] text-slate-400">
                Export Back
              </span>
              <span className="text-[11px] font-medium text-slate-500">
                ready for your agent
              </span>
            </div>
            <div className="mt-5 rounded-[24px] border border-white/10 bg-slate-950/75 p-4 shadow-[inset_0_1px_0_rgba(255,255,255,0.05)]">
              <div className="space-y-3 text-sm text-slate-200">
                <div className="rounded-2xl border border-white/10 bg-white/5 px-3 py-2">
                  <p className="text-[11px] uppercase tracking-[0.22em] text-slate-500">
                    Exported comment
                  </p>
                  <p className="mt-2 font-mono text-xs text-teal-100">
                    Lines 49-50 (new)
                  </p>
                  <p className="mt-2 text-sm leading-6 text-slate-300">
                    Handle range selection consistently and preserve the whole
                    selection when exporting the feedback.
                  </p>
                </div>
                <div className="home-agent rounded-2xl border border-emerald-300/20 bg-emerald-300/10 px-3 py-2">
                  <p className="text-[11px] uppercase tracking-[0.22em] text-emerald-100/80">
                    Agent Handoff
                  </p>
                  <p className="mt-2 text-sm leading-6 text-emerald-50">
                    Apply the requested changes and return an updated patch.
                  </p>
                </div>
              </div>
            </div>
          </article>
        </div>
      </section>
    </>
  );
}
