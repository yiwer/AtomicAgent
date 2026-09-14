# Cloud fixture deployment — 2026-09-14

Scope: user's explicit deployment request for `159.75.158.26`, `agent.91boy.cn`, and GitHub CI for `yiwer/AtomicAgent`. Ticket12 and human acceptance remain pending.

| Evidence | Result | Source / limit |
| --- | --- | --- |
| GitHub CI | PASS | [34804178451](https://github.com/yiwer/AtomicAgent/actions/runs/34804178451): typecheck, 139 Node tests, 3 Linux Guardian tests, build, 19 browser tests; main automatically deployed `16824bc` |
| Deployment inspection failures | PASS | `tests/cloud_deploy_test.py`: 2 tests on Linux; exact original-name absence differs from unavailable daemon; stopped container retains immutable image identity |
| HTTPS | PASS | Trusted certificate issued for agent.91boy.cn, expires 2026-12-13; HTTP 301 to HTTPS, Secure/HttpOnly/SameSite=Strict session; Certbot timer enabled and reload hook installed |
| Public API and file contents | PASS | [api.json](api.json): unauthenticated 401; foreign Origin 403; CSV Run `116e2da3-764f-4bd8-906e-a088ffa4ae9c`, 4 input / 3 valid / 1 rejected, total `12.6`; both artifact byte counts and SHA256 match |
| Actual cloud rollback | PASS | Candidate image deliberately exits 23; deployment returns 1; restored image `sha256:9825c8a56832ef2dd31359cbbb5f1854f8eddaf40893f54e054369dd00c55e84`; authenticated readiness passes before maintenance removed; zero snapshots remain; failure image removed |
| Persistence after rollback | PASS | `api.json` rechecks same Run and both artifact hashes at 04:09:06 UTC after container replacement; no fixture rerun used to replace the original |
| Cloud browser | PASS | [browser.json](browser.json), [desktop](desktop.png), [mobile](mobile.png): login, submit/result/cleanup, reload session, limits view, no page errors; mobile document has no horizontal overflow. Screenshots visually inspected; this is automated evidence |
| Existing services / exposure | PASS | Five original Relaticle containers remain healthy; app `4310/tcp -> 127.0.0.1:14310`; non-root/read-only container, 768 MiB cap, no Docker socket |
| Review | PASS | [review.md](review.md): original Standards 2 / Spec 1 findings fixed and independently rechecked |
| Real model / gVisor / production capacity / human experience | UNVERIFIED | Fixture does not call a model or create per-task Docker resources. App container is deployment infrastructure, not proof of task sandbox qualification |

Script observed during the first rollback verification: SHA256 `c1a7c45cd531614ea690f7bcebd62099a22ef1da38a5254c0e702f65bffbc0e3`; Nginx configuration SHA256 `92603c034aec7d7601af8293d748567a41e35017220a59569903c319d7cde185`. Config and identity secrets are excluded from evidence and repository. Final workflow uses official checkout v7.0.1 / setup-node v7.0.0 commit pins to remove the first run's Node20 deprecation warning; subsequent actual runs are visible in GitHub Actions.

Transfer follow-up: run `34805086309` passed 139 Node / 5 Python / 19 browser tests, but its full-image transfer slowed and was cancelled before release switching after a newer commit superseded it. A later runner was observed receiving only about 1.9 MiB in 143 seconds; Docker remained idle/healthy with no daemon errors. The release path now compares package and Docker recipe hashes and transfers only application files when dependencies match. An actual 117,578-byte bundle was built offline on the cloud using the approved immutable dependency image; non-root reads of main, web and check files passed. Seven deployment boundary tests passed on Linux, including unsafe archive members, changed dependencies, oversized PAX metadata and duplicate directories. Final CI verifies this new path separately; these preflights do not imply that final run has already completed.

Failure history: initial public browser harness timed out because reload restores the selected Run dialog, which intercepted the limits click. The harness was corrected to verify the restored result and close that dialog; no product behavior was changed. Initial release readiness briefly observed connection refused during normal startup, then passed on retry. The deliberately broken candidate was rejected and rolled back; it is not recorded as a successful deployment.
