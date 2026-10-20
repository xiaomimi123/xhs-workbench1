# APIMart image service integration

User approved settings/service configuration and image-creation provider selection. Implement within existing workspace, preserving uncommitted changes. Use writing-plans, TDD and subagent-driven-development; no real generation without user-configured key, no publication.

## Tasks
- [x] Server service: fixed official APIMart endpoint, server-only .secrets config (0600, excluded from backups), public masked settings, GET models connection/auth check. Inject HTTP transport for fixture tests.
- [x] Image lifecycle: current-agent retained; APIMart submit once, persist remote id, explicit refresh polls/downloads and reuses PNG validation/gallery/library/Live path. Reference snapshots as data URI, preserve poster/title intent. No failover/resubmit on uncertain outcome; n=1 until multi-output contract is unambiguous.
- [x] UI: connections/settings API key form; images provider/model/aspect/resolution selectors, disclosure of third-party transfer, remote status/refresh without agent handoff.
- [x] Routes/auth: GET/PUT /api/images/service, POST /api/images/service/test, POST /api/images/refresh. No raw secrets in responses, logs, job snapshots, downloads or backups.
- [x] Tests: mocks submit/poll/download and references, duplicate/unknown submit outcomes, key mask/file permissions, route auth, original agent flow compatibility. Local UI smoke; no paid generation.
- [x] Research: official generation.md and connection FAQ; direct curl with --noproxy shows 401 but remote198.18.x.x and proxy discovery mean direct mainland connectivity remains unverified.

## Verification (2026-10-19)
- Full suite: 197 tests, 194 passed, 0 failed, 3 skipped (opt-in browser/native Live Photo/native QR).
- Follow-up Agent aspect regression: reproduced failing 16:9 vs 3:4, fixed, image-workflow + APIMart-workflow tests passed.
- Local Ego browser: settings displayed; missing-key connection test rejected before network; APIMart provider displays model/aspect/resolution with count 2/3 disabled. Pointer/screenshot tooling encountered errors; verified controls via DOM and selectOption, not a successful screenshot review.
- Existing Agent flow remains 3:4; APIMart defaults gpt-image-2, 16:9, 2k. Remote lifecycle verified with injected HTTP fixtures, not paid generation.
- No API key configured; real authenticated generation, actual returned image format/CDN and reference fidelity remain unverified. PNG import accepts short edge >=512 and long edge <=4096, max20MB.
- Current Mac unauthenticated POST reached endpoint (401); --noproxy does not exclude transparent proxy/TUN. Resolved remote198.18.4.17 and automatic proxy discovery/PAC prevent claiming mainland no-proxy reachability. No network settings changed.
- Official references: https://docs.apimart.ai/en/api-reference/images/gpt-image-2/generation.md and https://docs.apimart.ai/cn/faqs/connection-usage.md . No mainland direct-access guarantee found.
- No Xiaohongshu browsing/publication, no existing materials or keys removed, no commit/push.

## Real generation acceptance (2026-10-19, after user saved key)
- Authenticated models check HTTP200. Saved default provider remains current-agent; test explicitly chose apimart without changing preferences.
- One POST via workbench /api/images/start, model gpt-image-2, 9:16, 1k, n1, watercolor orange cat prompt.
- Local job imagejob_mvexw95m189ef5; remote task task_01M59HC8BTV9YJ6XZXKQAGEBV3. API reports completed, actual_time27s.
- Real authenticated task response returned HTTPS getapib.org/f/image/...png, unlike documentation upload.apimart.ai. Exact getapib.org hostname added to CDN allowlist; credentials, alternate ports, HTTP, lookalike hosts and redirects remain rejected. No authorization forwarded to CDN.
- Added regression test, observed failing before fix; 20 related tests passed after fix. Restarted idle bridge and refreshed original task only, no second submission.
- Job done; PNG downloaded and visually inspected, 941x1672, generator apimart. Existing notes/materials untouched, no publication. Reference-image generation and mainland no-proxy routing not tested in this acceptance.
