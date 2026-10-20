# Collection control and manual publishing implementation plan

Approved by user on 2026-10-19. Execution uses subagent-driven-development, preserving existing uncommitted work; no commit or real platform access.

Goal: explicit collection sessions, persistent stop controls, reduced redundant navigation, manual-only publication.
Architecture: central account access policy checked before dispatch and queued execution; worker identity proof bound to current context; collection intents require explicit authorization; scheduler emits reminders only.
Tech stack: Node.js, Playwright, node:test.

## Tasks
- [x] Access policy and dispatch: add tests for paused/login/restriction persistence, resume rejection for restrictions, queue/manual/Agent gate; implement access-policy.mjs and Bridge checks plus cancellation; expose status and explicit login resume.
- [x] Collection intent: tests ensure candidate checkpoints only register pending intents; explicit fill/resume authorizes selected existing targets, new arrivals stay pending; clear authorization after attempt.
- [x] Worker: tests for explicit identity preparation, no repeated creator navigation, modal/history return, ready conditions, bounded abortable pacing, five independent checkpoints.
- [x] Manual publication: regression for legacy auto schedules emits reminder without dispatch; normalize UI/config and publish instructions.
- [x] Isolated real browser: fulfill all requests with local fixture pages, no outbound; verify five notes, partial result stop, persisted files, unchanged old content.
- [x] Review and verification: run related tests, inspect integration, save verification report; no real account crawling/publication.

Constraints: login profiles and original data preserved; no anti-detection guarantees; account restriction cannot be released by ordinary resume; arbitrary externally run agents are outside server enforcement.

## Verification — 2026-10-19

- `XHS_ISOLATED_BROWSER_TEST=1 node --test tests/*.test.mjs`: 184 total, 182 passed, 0 failed, 2 skipped. Isolated real Chromium test included.
- Fixture: explicit prepare, one profile navigation per collection, five independently saved notes with likes/collects/comments; avatar and profile screenshot saved; profile bio/followers/following asserted. Third-note challenge preserves first two notes and invalidates preparation.
- All fixture page requests fulfilled locally; other context requests aborted. OCR and avatar download use deterministic local stubs; real OCR/CDN and real Xiaohongshu not validated in this run.
- Account locks persist, disarm old batch authorizations, reject ordinary recovery of restrictions; queue/manual/CLI browser entrances gated. Browser-enabled inbox disabled because external execution cannot reliably be interrupted; local-only inbox carries an explicit no-browser/no-publish instruction.
- Manual publishing: legacy auto schedules normalize to reminders; automatic publish dispatch and UI actions removed. Radar schedules also remind only.
- Reviews found and fixed: stale batch revival after unlock, externally claimed inbox execution, malformed queue null items preventing locks, truncated diagnostics hiding captcha.
- Workbench restarted only after pending/running both zero. Postrestart pending/running zero; default account remains restriction-locked, collection paused, scheduled items zero. Local UI controls and lock message verified.
- Original Xiaohu benchmark directory compared with preexisting backup: 37 files byte-identical. Login profiles untouched.
- Existing unrelated image/Live Photo changes preserved. No commit or push, no real publication, no actual Xiaohongshu browsing.

Artifacts: `output/playwright/browser-worker-isolated/summary.json`, profile/avatar evidence, five note JSON/PNG pairs, two challenge-retained JSON files. They are fixture data, not real account observations.
