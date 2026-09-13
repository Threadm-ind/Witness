# GUARD — Witness

Pre-ship protection pass, 2026-09-13.

| # | Gate | Verdict |
|---|------|---------|
| 0 | Repo posture | EXCEPTION — deliberately public (see below). No build output tracked. Committed + pushed = authorship record. |
| 1 | Ownership claim | PASS — MIT `LICENSE` (Alex Evoy). `package.json` keeps `"private": true` (not an npm package; source-open, not registry-published). |
| 2 | Shipped surface | PASS — Vite `build.sourcemap` unset (off); `dist` ships minified hashed bundles; readable source stays in the repo. |
| 3 | Visible claim | PASS — footer `© 2026 Alex Evoy` + `<meta name="author" content="Alex Evoy">`; build exits 0. |
| 4 | Fingerprint | PASS — `ae-witness-438992` as HTML comment inside `<body>` and `--ae-mark` on `:root`; registered in `~/.claude/guard/fingerprints.json`. |
| 5 | Paper trail | PASS — no client, no IP clause needed. Commit + push is the timestamped proof. |

## Deliberate-public exception (gate 0)

Hackyard Yard #2 mandates a solo open-source repo plus demo video. This repo is
public by contest requirement, not by accident — logged here per guard rules.
This overrides the standing Threadm-ind everything-private posture for this one
repo only. No other repo is affected.

## NEEDS-ALEX

- None for protection. Submission upload itself remains your action.
