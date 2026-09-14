# Deployment dual-axis review

Fresh read-only agents `cloud_review_standards` and `cloud_review_spec`; baseline `41b983f837dc712ff82ab9b9caf5aca404abb9e9`. Spec: user's cloud/domain/CI request and `docs/cloud-deployment.md`. Standards: CLAUDE/domain/PRD and code-review smell baseline.

## Standards

Original two P2 findings: whole-data backups lacked retention/deletion; signed URLs could enter HTTP access logs or HTTPS upstream error logs. Fixed in `16824bc`: transaction snapshots are removed and absence checked after success, consumed on rollback without failed archives; both virtual hosts disable access logs and discard request-bearing error logs. Reviewer rechecked both closed, no outstanding finding. This does not claim all future product retention tickets are implemented.

## Spec

Original P2: failed preflight could remove an existing maintenance gate without a healthy release. Fixed in `16824bc`: independently establish previous readiness, preserve unhealthy/pre-existing gates, and only reopen after successful rollback readiness. Reviewer rechecked closed.

Additional final review: strict original-container absence parser and two tests, plus official Node24 Action pins — no new finding. Actual cloud verification is recorded separately, not inferred from review.

## Small-bundle follow-up

Fresh agents `bundle_standards` / `bundle_spec`, baseline `5d75a16` to `a89e547` plus reviewed fixes. Standards reported P2: PAX/GNU metadata could evade yielded-file byte accounting; a 6,430-byte compressed diagnostic with 6 MiB metadata reproduced it. Spec independently reported P2: directory entries bypassed member count/duplicates/size and receive deadline. Both were fixed with pre-parse compressed/raw byte bounds, a 300-second receive deadline, all-member counting/deduplication, directory payload rejection, and path-length bound. Both reviewers rechecked: zero outstanding findings. Seven deployment tests passed on Linux, including the original PAX counterexample and duplicate directories; final actual bundle CI is tracked independently in Actions.
