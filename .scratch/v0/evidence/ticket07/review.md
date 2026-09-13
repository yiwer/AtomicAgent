# Ticket07 code-review ledger

Fixed whole-ticket baseline: `ea6b4d4632e73ae958f3994f9382f9f31d10ac7d`.
Initial candidate: `4b5d005`; fixes: `849719d`, `1d6ce91`.
Both axes ran as fresh read-only subagents. Reviewers did not edit files or rerun tests.

## Standards

Initial review: one P2 documented-standard violation. MCP journal only retained cumulative counts, generated invocation identities after successful acquisition and did not persist permission denials or failed source calls. This violated audit-monitoring A-04 and domain InvocationRecord requirements. Nonblocking judgement calls: Repeated Switches in configuration kind handling; possible Divergent Change in the small research module.

849719d recheck: primary paths fixed; duplicate read_source still rejected before recording a denial, so the same original issue remained open.

1d6ce91 recheck: original P2 fully closed. Duplicate read now persists a new call identity, registered source and denied outcome before returning failure. No new hard standards violations found. Nonblocking judgement calls remain nonblocking.

## Spec

Initial review: three P2 findings, no scope creep.

1. Per-source invocation identity and partial acquisition facts disappeared when a later source/model/candidate failed; permission denials were not recorded. This overlaps the Standards finding.
2. Unobserved requests/bytes remained numeric zero after lost execution receipt and unreadable journal. Unknown observations must not imply zero consumption.
3. Store.accept grant.freeze still reported model-only for a research Run despite its registered-readonly manifest.

849719d recheck closed items 2/3 and most of item 1. Requests/bytes are nullable with explicit completeness; controlled invocation evidence is imported before candidate validation; grants record fixed MCP revision/digest. Item 1 retained the duplicate-source omission.

1d6ce91 recheck closed all three original findings, with no new blocking Spec risk or scope creep. Duplicate denial does not increment actual read requests.

Root additionally identified Skill health failure counts incorrectly including MCP-only failures. The fix scopes counts to actual selected capability; the public health regression proves MCP failure does not add a Skill failure.

Final: Standards 0 open hard findings (1 initial); Spec 0 open findings (3 initial). The shared audit issue is one independent issue, not two. Three independent reviewer findings plus one root attribution regression were fixed. Real model, deployment isolation and human semantic acceptance remain explicitly unverified.
