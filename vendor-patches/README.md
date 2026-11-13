# Vendor source checkpoints

## G2C Codex dialogs

`g2c-codex-dialogs.patch` is a source checkpoint of the G2C working tree used for the bundled glasses app. It is based on public upstream commit `77f1e0a26734a0cf01ad503ec105f4303e01cb9e` and contains 10 modified files plus 14 new files.

- Patch SHA-256: `6054a1660f6759d84850455e7bff101921d5cf1676623fed854c604a22d56808`
- Current source-tree SHA-256: `7750c10e95b7671c8103bc992d22a5f886374d6952482f87013db09b4d97819e`
- Changed-file manifest SHA-256: `415e0367429677c2b17e76b21531683ddb1663bb07b7d5a8a7ceb321c8b0d7af`

The source-tree hash is the SHA-256 of a path-sorted manifest containing the SHA-256 of every Git-tracked and untracked non-ignored file in the checkpoint. The changed-file manifest covers the 24 files represented by the patch.

Verification used a private clean clone detached at the pinned base. `git apply --check` succeeded, applying the patch produced exactly the expected 24 changed paths, and every resulting file byte-compared equal to the checkpoint working tree. The source archive was also extracted independently and its 54-file manifest matched the working tree.

Publication review found credential-related identifiers in `conductor_api.py`, `glasses/src/api.ts`, `glasses/src/screens.ts`, `glasses/src/store.ts`, and `glasses/tests/api.test.ts`. They are API parameter or state names plus a short synthetic test fixture; no known-format live credential or private-key block was found. No private-network literal, machine-local path, or private health record was found in the patch.

This proves preservation and replay of the source checkpoint only. It does not prove byte-for-byte reproduction of built JavaScript or an EHPK artifact.
