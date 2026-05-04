# AgentReview

Generate LLM-friendly code review payloads from git or Sapling diffs, and review them in an interactive web UI.

AgentReview bridges version control and AI-assisted code review. The CLI extracts structured payloads from your changes, which you can pipe to an LLM or open in the built-in web interface for interactive review with syntax highlighting, inline comments, and one-click export.

## Install

```bash
pip install agentreview
# or
uv pip install agentreview
```

Requires Python 3.10+.

## Quick start

```bash
# Review all uncommitted changes (staged + unstaged + untracked)
agentreview

# Copy the payload to clipboard for pasting into an LLM
agentreview | pbcopy

# Open the interactive local review UI in your browser
agentreview --local
```

## CLI usage

```
agentreview [OPTIONS]
```

### Diff modes

Use one of these at a time:

| Flag | Description |
|---|---|
| *(default)* | All staged, unstaged, and untracked changes |
| `--staged` | Only staged changes (Git only) |
| `--branch BASE` | Committed changes relative to BASE branch |
| `--commit COMMIT` | Committed changes since COMMIT |

Add `--uncommitted` to `--branch` or `--commit` to also include working tree changes.

### Other options

| Flag | Description |
|---|---|
| `--local` | Launch the local web UI instead of printing a payload |
| `-v, --verbose` | Print timestamped progress to stderr |
| `--version` | Print version and exit |

### Examples

```bash
# Review only staged hunks
git add -p && agentreview --staged

# Review a feature branch against main
agentreview --branch main

# Review last 3 commits plus uncommitted work
agentreview --commit HEAD~3 --uncommitted

# Save to a file
agentreview --branch main > review.txt

# Use a custom base URL for proxied dev environments
BASE_URL=http://devserver:8080 agentreview --local
```

### Supported VCS

- **Git** -- full support (staged, branch, commit modes)
- **Sapling (sl)** -- full support (branch, commit modes; no `--staged`)

## Web UI

The web interface is available at [agentreview-web.vercel.app](https://agentreview-web.vercel.app/) or locally via `agentreview --local`.

### Features

- **Unified and split diff views** -- toggle between inline and side-by-side
- **Syntax highlighting** -- powered by Shiki with 26+ language grammars
- **Inline comments** -- add line-level and segment-level comments with edit/delete
- **Commit segments** -- navigate individual commits when reviewing branch/commit ranges
- **Code folding** -- collapse unchanged sections in large diffs
- **Context expansion** -- reveal hidden context lines in diff gaps
- **Large diff handling** -- diffs over 1500 lines are deferred and rendered on demand
- **Export** -- copy diffs or formatted comments to clipboard
- **Dark/light theme** -- follows system preference with manual toggle
- **Keyboard shortcuts** -- press `?` to see all shortcuts

### Keyboard shortcuts

| Key | Action |
|---|---|
| `?` | Show shortcut help |
| `E` | Expand all files |
| `D` | Copy full diff |
| `C` | Copy comments |
| `A` | Copy all (diff + comments) |

## Payload format

The CLI outputs a base64-encoded JSON payload wrapped in markers:

```
===AGENTREVIEW:v1===
<base64-encoded JSON>
===END:AGENTREVIEW===
```

The decoded JSON contains:

```jsonc
{
  "version": 1,
  "meta": {
    "repo": "my-project",
    "branch": "feature-branch",
    "commitHash": "abc123",
    "commitMessage": "Add new feature",
    "timestamp": "2025-01-15T10:30:00-07:00",
    "diffMode": "branch",
    "baseBranch": "main"
  },
  "files": [
    {
      "path": "src/app.py",
      "status": "modified",       // added | modified | deleted | renamed
      "diff": "unified diff text",
      "source": "full new file",  // optional
      "oldSource": "full old file", // optional
      "language": "python"        // optional
    }
  ],
  "segments": [                   // present in branch/commit mode
    {
      "id": "commit-abc123",
      "label": "Commit abc123",
      "kind": "commit",
      "commitHash": "abc123",
      "commitMessage": "Add new feature",
      "files": [...]
    }
  ]
}
```

## Development

This is a pnpm monorepo with two packages:

```
packages/
  cli/    Python CLI (Click + Hatchling)
  web/    Next.js 14 web app (React, TypeScript, Tailwind, Shiki)
```

### Prerequisites

- Python 3.10+ and [uv](https://docs.astral.sh/uv/)
- Node.js 18+ and [pnpm](https://pnpm.io/)

### Setup

```bash
# Install web dependencies
pnpm install

# Install CLI dependencies
cd packages/cli
uv sync --frozen
```

### Running locally

```bash
# Web dev server (http://localhost:3000)
pnpm dev

# CLI
cd packages/cli
uv run agentreview --help
```

### Building

```bash
# Web
pnpm build

# CLI package
cd packages/cli
uv build
```

### Tests

```bash
cd packages/cli
uv run python -m pytest tests/
```

## License

MIT
