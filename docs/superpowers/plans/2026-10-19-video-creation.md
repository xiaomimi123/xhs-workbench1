# Video creation implementation

Approved: sidebar video creation; service URL/key entered in settings. t2v/i2v/r2v, duration presets, existing generated image entry. No publishing or replacement of drafts. Existing workspace edits preserved.

- [x] Service: HTTPS only, server-side secrets, optional explicitly supplied CA scoped to gateway, no insecure TLS; capabilities/test without generation; do not list shared remote jobs.
- [x] Workflow: account isolation, frozen input/images, validate frame grid, submit once, persist remote id, manual refresh and download without resubmit; bind job to gateway; validate MP4 locally. No cancellation API claimed.
- [x] UI: sidebar, modes/duration/ratio/prompt, uploaded/existing images, task statuses, local preview/download. Settings masked key, clear key, certificate input.
- [x] Verify mocked generation/download/restart/security, HTTP routes and UI; live unauthenticated TLS health only until configuration works. No automatic paid test.

## Verification
- Full regression: 203 tests, 200 passed, 0 failed, 3 opt-in/native skips. Additional final targeted suite (video service/workflow/UI + HTTP): 29 passed, 0 failed.
- Real local workbench: sidebar video entry opens; duration8 ->192 frames/8.00s; i2v sees6 existing image sources; settings has HTTPS URL/password field/optional PEM certificate; no secret prefilled.
- Existing powder output imagejob_mvey2abkcf40eb -> 制作视频 -> i2v with that exact image checked and motion prompt populated. No task submitted by navigating.
- Ego pointer action to offscreen settings button intercepted; recovered through DOM click. No successful screenshot-based visual review claimed.
- Local server restarted only after bridge idle and no remote image submission active.
- No real video submission, key storage, publication or image replacement. Real endpoint previously failed default TLS verification due self-signed certificate; user must supply valid HTTPS domain or independently trusted matching PEM certificate and enter key locally.
- Download validation uses local ffprobe (available here); other installations need ffprobe. Tests inject valid/invalid fixtures; actual provider video format/quality remains unverified.

## API(2) real retrieval correction
- New provided document adds GET /jobs/{id}?wait=60, 75s query timeout and 300s download timeout. Backend now queries persisted known jobs independently of open UI, bounded30-minute retrieval window with failure backoff; never repeats generation POST.
- Node HTTPS and curl failed before HTTP response, while browser HTTPS returned200 for same origin/task. Therefore previous blanket attribution to gateway/network was insufficient; confirmed client transport difference, not failed server generation.
- Added read-only Chromium compatibility fallback for connection failures, fresh isolated context, fixed gateway read paths, header auth, redirect rejection, byte limits and normal certificate validation. Never fallback POST or certificate failures.
- Actual task7426747b0af1 returned done. Downloaded2145918 bytes, ffprobe576x768,5.167s. Stored original local job videojob_mvf1u2nk223ad4 as done. Direct integrated service poll+download confirmed same SHA256 as saved video. No new generation.
- 37 targeted tests passed. Existing original media preserved; no publication.
