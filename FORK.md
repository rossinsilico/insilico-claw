# Insilico Claw development

Insilico Claw is Ross's iOS-focused fork of James Babcock's
[FaceClaw](https://github.com/jimrandomh/faceclaw). It keeps the shared
NativeScript, TypeScript and Kotlin architecture rather than splitting iOS into
a separate codebase. FaceClaw's GPLv3 license and third-party notices remain in
force. This is an independent fork, not an official Even Realities product or
Jim's TestFlight release.

## Source baseline

The Pilot import starts from upstream commit
`70ec2a0d6afd92e8185234e57ab013fcb596bf4d`. It records the existing local work
as an honest checkpoint rather than inventing an incremental commit history.
Upstream changes after that commit have not been merged into the Pilot baseline.

The retained iOS candidate is version 0.9.0, build 35. Its source passed the app
TypeScript check and 1,518 of 1,523 host tests, with three skips and two known
onboarding failures:

- `choosing glasses selects exactly one, and the accessories are stored`
- `the watch follows the platform, and iOS can't choose a RayNeo iO`

These are checkpoint results, not a claim of a fully green release or completed
wearer acceptance. Android parity and every background/recovery path have not
been verified. Build 35's new notification controls still need physical-device
acceptance. No firmware change is part of this import.

After the publication packaging changes, the fresh host suite has 1,519 passes
out of 1,524 tests, the same two onboarding failures and three skips. App
TypeScript and generated-document consistency checks pass.

Publication preparation adds attribution and privacy documentation and restores
the MIT notice inside newer bundled G2C archives. Those archives preserve their
existing executable payloads and package identities but have new archive hashes.
The retained signed build 35 and its original packages are kept separately;
this source import does not claim to reproduce that signed artifact byte for byte.

## Repository workflow

- `pilot` is the fork's default development branch and holds our product changes.
- `main` retains the upstream snapshot copied when the GitHub fork was created.
- `origin` points to `rossinsilico/insilico-claw`; `upstream` points to
  `jimrandomh/faceclaw`.
- Keep work in small, reviewable commits from this checkpoint onward. Contribute
  generally useful fixes through separate branches based on current upstream.
  A source checkpoint is not authorization to publish an upstream issue or PR.

The app's existing iOS bundle identity is retained so this repository setup does
not require replacing the installed app or migrating its preferences and data.
Repository branding and an eventual app-name change are separate from that
identity.

## Building and configuration

Install the existing dependencies with `npm ci`. The iOS entry point is
`scripts/ios.sh`; shared native build details are in
[the Kotlin instructions](native/kotlin/README.md). Configure the local signing
team through `IOS_TEAM_ID` in the ignored `build_paths.sh`, and set
`IOS_BUNDLE_ID` when building under a different app identity. Provisioning
profiles and signing keys stay outside Git.

Run `npx tsc --noEmit` and `npm test` for source checks. A physical build uses
`bash scripts/ios.sh build ios --for-device` with the documented native toolchain.
It requires a valid local signing setup. Simulator and host checks cannot verify
Bluetooth behavior or the glasses display.

Assistant endpoints, API keys, G2C setup codes, device pairings and health records
are user configuration, not repository defaults. Exported phone settings and
private recovery snapshots must not be committed. Private source archives and
Git recovery bundles are retained outside this repository; `.private-backups/`
is also ignored.

## Bundled G2C

G2C is a separate MIT-licensed application. Its upstream attribution, package
hashes and source-patch limits are recorded in
[the bundled-package notes](app/assets/evenhub/README.md). Its connection remains
user-configured. Keeping it in FaceClaw's compatibility layer does not merge its
independent backend or credentials into this repository.

## Contributions and distribution

Keep copyright, license and modification notices intact. Changes distributed
with this GPL-covered app must meet the license's corresponding-source
requirements; third-party notices also apply. Test changes on the relevant
physical hardware before describing them as wearer-verified. Update `PRIVACY`
when changing data handling or integrating another service.

The newer Apple accessory-notification integration remains a separate research
and eligibility gate. It is not implemented or advertised as a feature of this
checkpoint. App Store distribution, new signing capabilities and firmware
changes each need their own verification.
