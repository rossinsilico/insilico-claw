# Assistant confirmations implementation plan

**Goal:** Resume the original direct FaceClaw assistant operation after explicit, correctly bound consent; request phone location permission on first use.

**Architecture:** Keep existing HTTP chat, stable conversation identity, native Codex harness and caller phone tools. Add the supported authenticated Gateway question and plugin-approval surface, using a paired iOS device identity. Retain the HTTP fail-fast guard whenever no verified answer surface exists.

**Tech stack:** NativeScript TypeScript, existing native WebSocket, CryptoKit and Keychain, installed OpenClaw 2026.11.2 Gateway protocol.

**Spec:** User-approved flow in this thread: show recipient and exact message, confirm explicitly, resume the same pending operation, report the real result. Existing sideband contract is in the local assistant-repair setup notes.

## Constraints

- Preserve current G2C, Herdr, Codex sessions, phone preferences and firmware write guards.
- No silent approval, expired consent, cross-conversation answer, automatic resend, or authentication downgrade.
- Ordinary questions and native plugin approvals are distinct protocols.
- No private messages sent during automated testing.
- No broad configuration changes, new service, public endpoint or additional orchestration layer.
- User is on glasses; use in-thread choices, never Spokenly.

## Tasks and ownership

1. Location worker: existing one-shot location adapter and focused tests. Reuse native when-in-use permission helper, preserve approximate weather access and navigation semantics.
2. Identity worker: new native Gateway identity helper and tests. Keychain key per gateway origin, challenge-bound Ed25519 signing, no private key in JavaScript.
3. UI worker: assistant callback types, session forwarding, shell confirmation layer, tests. Full prompt pagination, explicit choices, cancellation and expiry; no clipped message approval.
4. Gateway debugger: repair snapshot runtime modules and tests. Verify exact installed RPC schemas, authenticate a live sideband bound to admitted HTTP authority, handle native plugin approvals without truncating approved text.
5. Root: Gateway transport, SSE run identity capture, direct backend integration and tests. Bind every operation to the active server run and conversation; close on termination/disconnect.
6. Independent review; focused integration checks and iOS build. Back up exact runtime/module/app preimages before deployment. Preserve coding services. Install only a verified build and distinguish device acceptance from local test proof.

Each implementation task follows failing test, minimal implementation, passing test. Existing dirty work is preserved; no bulk commits or cleanup.

## Review focus

- New prompt arriving after cancellation or after a different conversation is selected.
- Same device reconnecting, token/permission revocation, expiry and ambiguous pending records.
- Long message or misleading label hiding what is actually being approved.
- Lost approval response after successful submission: never replay a send automatically.
- iOS background or denied location access: clear actionable error, no indefinite wait.

## Progress

- Inventory and failure trace complete. Current failure is an unanswered native consent prompt, not JSON parsing.
- Location, identity, UI and Gateway work assigned with disjoint ownership.
- Interface check: UI callback is consumed by root transport via session; identity is consumed only by Gateway client; server capability contract must be finalized before enabling it.
- Ruling: preserve separate native question and plugin approval validation; generic chat confirmation is not consent.
- Location, identity, UI and transport implementations complete; focused tests and independent review pass.
- Reviewer fixes: bound-session concurrency, trusted cancellation after disconnect, page-paint selection gate and synchronous UI initialization are covered by regressions.
- Mac modules backed up, exact-hash deployed, and Gateway-only restart completed. Config, authentication, Tailscale and direct coding processes preserved.
- Live authenticated HTTP binding, negative unbound connection, and same-run core-question continuation pass. Native MCP consent and real send remain device acceptance gates.
- Historical checkpoint: Pilot build 4 was compiled and signed, with installation held while the wearer was away. Signed app artifacts are retained outside the source repository.
