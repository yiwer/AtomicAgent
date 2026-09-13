# Ticket01 review

Review baseline: `fdc48da27fdc1270383d8fb0e500626f4d5bbf7e` (approved documentation baseline).
Initial implementation: `c4a266f`.
Command: `git diff fdc48da27fdc1270383d8fb0e500626f4d5bbf7e...HEAD`.

The implement skill required code-review; its two independent review agents inspected Standards and Spec. No live model credentials were read by review agents. Findings below are their initial reports, followed by resolution evidence.

## Standards

1. **P1 — Storage failure blocks recovery cleanup.** `recover()` calls `finish()` before contacting the provider. If that transaction fails, startup aborts and no cleanup is attempted for the persisted running allocation. Likewise, failure to persist one cleanup observation prevents later obligations from being attempted. This violates ADR 0006: when critical records cannot be written, stopping and cleanup must retain a bounded fallback path.

   Fixed: recovery uses already-read immutable identities and attempts each disposal despite terminal/observation write failures, then refuses startup. The executing worker also retains newly observed resource identities for cleanup if saving them fails. Re-review identified a remaining pre-recovery write transaction in `registerProfile`; matching registrations now validate with reads alone. Three SQLite fault tests cover later obligations, failed terminal writes, and an existing writer lock. Reviewer confirmed resolution, limited to readable databases with the existing schema.

2. **P2 — Cleanup audit records the business outcome instead of the cleanup observation.** Every `change()` previously audited `run.failure ?? run.status`. Therefore a successful Run whose cleanup returned unknown was audited as succeeded; a failed Run successfully cleaned up retained its business failure as the cleanup outcome. Historical records could not distinguish these outcomes after later updates. This violated DM-08, audit record result/evidence requirements, and A-07.

   Fixed: cleanup changes atomically record their own outcome, source, opaque resource/operation identity and observation timestamp. Fault tests inspect these critical records and then verify reconciliation through the public Run API. Reviewer confirmed resolution.

Heuristic: the generic Store change interface hid distinct outcomes behind a primitive fallback. The concrete behavior was corrected; broader module splitting was optional.

## Spec

1. **P1 — Validate persisted execution bindings before recovery or dispatch.** The initial app compared the adapter only with the current profile. Recovery then processed previously persisted Runs through that adapter without validating their frozen manifest. Restarting live Runs with fixture configuration could commit simulated success or fabricated resource absence; changing the provider endpoint could query another provider. Ticket01 requires a fixed ExecutionManifest, no silent substitution, and confirmation of resource absence.

   Fixed: registration and every persisted manifest are validated before recovery, including legacy records without registration metadata. Profile mode/model/provider address cannot change in place. Main verifies that the actual provider URL matches the frozen endpoint. Restart tests cover changed model, live→fixture and changed provider URL. Reviewer confirmed no remaining binding finding and no additional concrete scope creep or SDK incompatibility.

Live execution remains unverified because the approved Linux node, exact model/endpoint and service-side secret bindings have not been provided. This is a recorded acceptance gap, not a passed requirement.

## Verification and status

- Initial failing TDD probes: missing first Run API implementation; adapter mode mismatch accepted; preparation exceeded the deadline; profile mutation accepted across restart. Each was observed failing and then passing after implementation.
- Full deterministic suite: 15 passed, 0 failed, 0 skipped.
- Real Chromium browser: 1 passed; desktop and mobile screenshots inspected.
- Typecheck, build, built-entrypoint process restart and duplicate-process rejection passed.
- Standards: 2 initial substantive findings, 0 unresolved after re-review; worst remaining: none within the reviewed readable-storage scope.
- Spec: 1 initial substantive finding, 0 unresolved code findings after re-review; real integration acceptance remains pending.

This report does not assert Linux/Docker/model/network/content qualification or human acceptance, and does not release dependent tickets.
