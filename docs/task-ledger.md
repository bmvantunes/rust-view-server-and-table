# Implementation ledger

Cleanup in progress on `refactor/typescript-tooling`, based on `202833c`. The qualification below records the previous delivered product; it does not qualify the in-progress tooling migration. Fresh integrated acceptance through the new tooling remains required.

The integrated product and full local campaign are qualified at `468e40cb9eefc4198499d98fed27141d7b057e5d`. Final documentation records those frozen executable bytes. See [qualification](qualification.md) and its [machine-readable evidence](qualification.json).

## Final status

| Checkpoint | Status | Result |
| --- | --- | --- |
| A: scaffold/import/provenance | DONE | Official VP scaffolds, exact required local integration and table imports, self-contained acyclic workspace; old repositories preserved |
| B: selected toolchain/compiler | DONE | Pinned current selected stack; documented compiler exceptions; numeric development/production gates pass |
| C: generic native/WASM fixtures | DONE | Same core, isolated production Provider fixtures, clean WASM build, native/browser parity, controlled consumer mutation failure |
| D: ordinary semantics/complete acquisition | DONE | Pinned Effect paired oracle, positive numeric/Unicode/absence/facet tests, bounded coherent snapshot/live tail |
| E: real integrated campaign | DONE | Two topics, two partitions each, 200,000 distinct initial live identities each; all 12 checks pass |
| Fresh-clone delivery | DONE | Frozen install, generate, build, check and fast test pass; tracked tree clean; declared cache inputs only |
| Company-specific Buf Decimal plugin | BLOCKED | Required company input unavailable; illustrative proto/Buf generation works; no mapping invented |
| Safari/PWA/broker-loss/virtualizer/compression | DEFERRED | Outside this qualification |

## Tests, review and recovery

Fresh fast suite: 208 native passes, 11 intentionally ignored, five legacy socket passes, 101 Provider browser passes, five complete-client passes, 1,176 table passes and 27 infrastructure/campaign passes. One separately invoked nested native helper is excluded from the native count. No Kafka or OrbStack access is required by these fast tests.

Separate reviewers examined implementation bytes and focused repairs. The final reviewer independently reconstructed all 409 producer-journal transactions, initial/final identities and hashes, native cuts and all 12 browser checks; no actionable evidence inconsistency remained. The lead subsequently confirmed clean-clone success and live process/Compose cleanup.

Short transport interruption recovered automatically. The full native restart took 31.94 seconds and exhausted the browser's unchanged 12-attempt policy; the same-page **Reconnect and reacquire** control then reacquired the complete data and observed a later committed update. This limitation is explicit in the qualification.

## Retained frozen campaigns

| Commit / run | Outcome |
| --- | --- |
| `0bcfc82` / `e2e-d2302fb0c2db4c53` | Failed transient source-readiness rejection; fixed bounded typed retries and ordering/cancellation |
| `781b40b` / `e2e-6bd3ea5593d44ecc` | Failed cumulative delivery gate before native catchup; added independent catchup gate and actual Worker byte measurements |
| `71e5fd0` / `e2e-953dd09d6e5c440a` | Failed 2,048-facet Worker reconstruction; aligned generic 4,096-row contract and tested overflow rejection |
| `f0180ef` / `e2e-171d2689f6a542f5` | Failed automatic browser recovery after native restart; retained budgets and qualified explicit retry honestly |
| `468e40c` / `e2e-fcab61f0c80341d7` | PASS: full frozen campaign, 400,000 initial live identities, all 12 checks, no cleanup errors |

Raw failures and the passing evidence remain under ignored `.local/e2e/`; fresh-clone logs are under `.local/fresh-clone/`. All owned long-lived processes, containers and networks stopped. Run-owned data volumes remain preserved; deletion requires explicit scoped reset. No remote push or publication occurred.

Local foundation: `a8c2fbf`; integrated implementation: `bf06e06`; frozen final executable candidate: `468e40c`. The final commit changes documentation only.
