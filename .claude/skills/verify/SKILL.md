---
name: verify
description: Drive the agentreview local review UI end-to-end with a fake agent CLI and headless Chromium to verify web/CLI changes at the real surface.
---

# Verifying agentreview changes

The product surface is `agentreview --local`: a Python CLI that builds the
Next.js static site (`packages/web` → `out/`), serves it on
`http://127.0.0.1:<port>/review/local?agentreviewSession=<id>`, and spawns
`claude`/`codex` CLIs as subprocesses for inline agent replies.

## Recipe that works

1. **Scratch repo + fake `claude` CLI** so agent runs are deterministic:
   - `git init` a temp repo with an uncommitted diff.
   - Put a `claude` shell script first on PATH. It must emit the
     stream-json protocol on success:
     `{"type":"system","subtype":"init","session_id":...}`, one or more
     `{"type":"assistant","message":{"content":[{"type":"text","text":...}]}}`,
     then `{"type":"result","is_error":false,"result":...,"session_id":...}`.
     For failures: write to stderr and `exit 1`. Drive fail/succeed via a
     counter file in /tmp so retries can be tested.
2. **Launch**: from the scratch repo,
   `PATH=<fakebin>:$PATH BROWSER=true nohup uv --project <repo>/packages/cli run agentreview --local > server.log 2>&1 &`
   (`BROWSER=true` makes `webbrowser.open` a no-op-ish success). First run
   builds web assets (~30–60s); wait for `Local review UI: <url>` in the log,
   and use that exact URL (session id is required).
3. **Drive with playwright-core** (`npm i playwright-core` in /tmp +
   `npx playwright-core install chromium-headless-shell`; no system Chrome here):
   - Add a line comment: `button[title^="Add comment"]` (appears per diff row),
     then fill `textarea` and press `Control+Enter`.
   - Agent status row: text `Agent is thinking`, `Agent replied`,
     `Agent reply failed`; expand via the `Agent replied`/status row button.
   - Follow-up: expand reply → `button:has-text("Reply")` →
     `textarea[placeholder="Reply to the agent..."]` + Ctrl+Enter.
   - Bottom-right bubble: text like `1 done` / spinner with pending count.
   - Cancel: `button[title="Stop this agent run"]`.

## Gotchas

- localStorage comments are keyed by session id; each server start gets a new
  session, so state does not carry across restarts — make scenarios
  self-contained.
- The agent endpoint streams NDJSON over one HTTP 200; errors arrive as a
  final `{"type":"error"}` line, not an HTTP status.
- CLI unit tests: `cd packages/cli && uv run python -m unittest tests.test_cli`.
- Web typecheck: `cd packages/web && npx tsc --noEmit`; full build `pnpm build`
  from the repo root.
