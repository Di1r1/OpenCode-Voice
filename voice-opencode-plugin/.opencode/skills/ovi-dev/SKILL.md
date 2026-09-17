---
name: ovi-dev
description: Use when developing or releasing OpenCode Voice — typecheck, pytest, sync-plugin.sh, CI workflow, version bumps, commit/push conventions, README/AGENTS/AUDIT updates, and distribution (ecosystem PR, npm, Chrome Web Store). Triggers build, tests, CI, release, commit, version bump, publish, docs.
license: MIT
compatibility: opencode
metadata:
  author: Di1r1
  audience: maintainers
  workflow: release
---

# OpenCode Voice — development and release

Repo root: `/mnt/c/temp/openvi` (public). Plugin: `voice-opencode-plugin/`.
Git remote `origin` = SSH remote of `Di1r1/OpenCode-Voice`, local branch `master` → remote `main`.
Push with `GIT_TERMINAL_PROMPT=0 git push origin master:main`.

## Change → verify loop

```bash
cd voice-opencode-plugin
npm run typecheck        # tsc --noEmit
bash sync-plugin.sh      # src/index.ts -> .opencode/plugins/index.ts (required for the running install)
bash sync-plugin.sh --check
python3 -m py_compile stt-server/stt_server.py
python3 -m pytest        # hermetic (no mic/model); pytest.ini lives here, tests in stt-server/tests
```

Rules of thumb:
- **Only `src/index.ts` is synced.** Files under `src/lib/` are imported directly by the synced copy
  (`./lib/` is rewritten to `../../src/lib/`), so lib edits need no sync.
- Keep `src/index.ts` free of top-level non-function exports (the loader throws).
- Config-time artifacts (plugin, skills, agents, commands, opencode.json) are loaded once: after changing
  them, **restart OpenCode**.
- A shim in `doctor.sh` checks CORS/health; run it after server changes.

## CI

`.github/workflows/ci.yml`, two jobs:
- **plugin**: Node 22, `npm ci`, `npm run typecheck`, `bash sync-plugin.sh --check`.
- **server**: Python 3.12, `pip install -r stt-server/requirements-dev.txt`, `py_compile`, `pytest`.
Pinned deps live in `stt-server/requirements.txt` (runtime) and `requirements-dev.txt` (CI/tests).
Tests must stay environment-independent: the suite tolerates missing `arecord`/`ffmpeg`/`sox` and sets
`OPENCODE_VOICE_RECOGNIZED_LOG=/dev/null` so it never writes into the real log.

## Versioning

- Extension: `extension/manifest.json` **and** the `content.js` console string (`vX.Y.Z loaded`) — bump both.
- Plugin package: `package.json` `version` (currently `0.2.0`).
- There is no plugin "release" step yet; the loaded copy is the repo file, so a restart picks up changes.

## Docs to keep in sync

| File | Content |
| --- | --- |
| `README.md` / `README.ru.md` | User docs (both languages; keep symmetric) |
| `AGENTS.md` | Architecture, entrypoints, commands, testing — update when behaviour changes |
| `AUDIT.md` | P0/P1 backlog with statuses; mark items done and bump test counts |
| `TEST_PLAN.md` | Manual test plan |

## House style

- No comments unless they explain a non-obvious *why*; existing comments are Russian/English mixed.
- Never commit secrets; the repo is public. The global `~/.config/opencode/opencode.json` holds a Google
  API key — never copy it into the repo.
- Commit messages: `type: short summary`, then a bullet body with the concrete changes.
- Recordings and logs stay in `/tmp` or `/dev/shm` — never in git.

## Distribution

| Channel | Status |
| --- | --- |
| Ecosystem listing | PR #49383 to `anomalyco/opencode` (`packages/web/src/content/docs/ecosystem.mdx`, base `dev`) |
| npm package | Not published yet (`AUDIT.md` P1) — an npm plugin id enables `opencode.json` install |
| Chrome Web Store | Blocked: needs icons and reduced permissions (`<all_urls>`), see `AUDIT.md` P1 |

Before publishing anything, re-run the sensitive-data scan: history and files must contain no keys,
tokens, personal paths or emails.
