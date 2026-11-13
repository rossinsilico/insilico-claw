# Bundled G2C package provenance

These archives contain locally modified builds of
[G2C](https://github.com/liyiyuian/tmuxor), copyright 2026 liyiyuian and
distributed under the MIT License. The exact upstream notice is published as
`LICENSE-G2C.txt` beside the archives and as `dist/LICENSE-G2C.txt` inside
every archive. FaceClaw remains licensed separately under GPL-3.0.

All packages keep the upstream package ID `com.liyiyuian.tmuxor` and the
version in their filename. Versions 1.0.45 through 1.0.48 were parsed and
repacked only to add the missing MIT notice. Every pre-existing decoded file,
including `app.json`, the built JavaScript, and `index.html`, is byte-identical
to its pre-repack counterpart.

| Version | Original SHA-256 | Published SHA-256 |
| --- | --- | --- |
| 1.0.43 | `12bc80c18a625e1875d9c4d0bb722ac32d5fb77a37ae9823289ca12adcbe0385` | unchanged |
| 1.0.44 | `d6647d61af16bcfeecdd0295a31c28f4fc1316405f345c2959fa9f6957bf90a9` | unchanged |
| 1.0.45 | `c7156efdb0549099dffbfc8bc2db61c28709f9cc7e63eaca6b21ff558de97d9b` | `548ff413b40a6497603f7d4aec9ffeccaa0ee745079519ec81c4553f7a4b57f6` |
| 1.0.46 | `7644850e3459ce992e093587bcd352b3a8e0ad50db25d2231d614ca028217316` | `5c54c75794682cd1160c56468658b40c23664900fa9046c9fcc1f2802c50fcba` |
| 1.0.47 | `e9d2f32614f06c522e761f1a2d3f076ae0e3f429135759a4cf242a8b33534132` | `f067a5d5e0ea5d0659ad830b095c0c3f82d1e688130b279b5f37ff58e4984227` |
| 1.0.48 | `96a4200cccd2ff9c1bd36e67d0109e6fe7794f4607112502071c16529b53c888` | `6bed1e692652129b3765ab66442fe7079a1f46a1f1e5951254f42582e1e4bc49` |

The original 1.0.48 hash above identifies the retained build 35 package. The
published hash identifies the license-repacked archive bundled by the app.

## Source-proof boundary

The earlier 13-file partial patch was incomplete and has been superseded by
the current 24-file
[`source checkpoint`](../../../vendor-patches/g2c-codex-dialogs.patch).
That checkpoint is maintained separately from these archives. Neither the
source patch nor this license-only repack claims byte-for-byte reproduction of
the built 1.0.48 JavaScript or EHPK. This packaging proof is limited to
preservation of the original decoded payload plus the MIT notice.
