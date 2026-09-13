# Fixed material facts and provenance

Full source snapshots were acquired by public HTTPS GET at 2026-09-13T22:55:48Z, HTTP 200. The runtime catalog saves only the first 12000 characters, with this coverage shown in each receipt. Network evidence reacquired the same immutable URLs through actual local MCP protocol at 23:21:30Z; no model was called.

| Source | Revision | Independent supported fact | Deliberately unsupported claim |
| --- | --- | --- | --- |
| opensandbox-group/OpenSandbox README | 60bca638497d9c50e948928b8b15fe22328afee3 | README line 23 describes a general-purpose sandbox platform and multi-language SDKs | Perfect production reliability; actual isolation qualification |
| mattpocock/sandcastle README | e99f832f26dc9d245c019a9ddd19fa5dee792427 | README line 11 describes a TypeScript coding-agent orchestration library; prerequisites explicitly list Git | Its cleanup implementation is verified from the README alone |

These assertions were read independently from the saved upstream README, not calculated from the fixture candidate. Fixture output is a deterministic demonstration, not model reasoning evidence. Exact quotation correspondence cannot mechanically establish a paraphrased claim's truth. The test with a genuine quote supporting “perfect reliability” must remain semantically unaccepted.

Attribution: OpenSandbox source is redistributed under Apache-2.0; see `opensandbox-LICENSE`. Sandcastle source is copyright (c) 2026 Matt Pocock, MIT; see `sandcastle-LICENSE`. Both license copies were fetched from the same fixed repository revisions. The README copies are unmodified; `src/research-snapshots.ts` contains explicitly marked excerpts. Original source URLs are in `network.json` and the runtime catalog.

OpenSandbox fixed revision NOTICE was checked by public GET and returned HTTP404; its Apache LICENSE is included. Network failures (redirect, oversized body, timeout) and source instruction text were tested at the fetch dependency seam; these are not Docker firewall or physical isolation evidence.
