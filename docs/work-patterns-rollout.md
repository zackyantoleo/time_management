# Work-pattern viewer / Worker compatibility rollout

Scope: deploy v2 read/validation support and report-first viewer. Do not publish a
personal report, enable v2 engine transport, change cron, read Telegram, migrate
D1, or change Worker secrets/bindings/auth policy.

## Release gates (2026-10-15)

- New isolated release worktree copied from verified local T5/T6 WIP; originals and
  canonical engine's three dirty files preserved without reset/stash/overwrite.
- Local full `node scripts/check.js`: 67/67 PASS (39 Node suites).
- Work-pattern browser smoke: 11 checks PASS, file/HTTP, no local report upload or
  persistence, error states, race, v1 compatibility and 320px layout.
- Correction file smoke PASS; three legacy Playwright specs PASS.
- Four synthetic-only screenshots: 320/1280, light/dark. Functional/layout checks
  PASS; no private screenshot or independent hosted reviewer.
- Shared v2 validator byte-identical to verified engine contract. Deterministic
  facts, citations, limits/counter-context and abstentions; no score/plan fields.
- Worker dry bundle PASS. Canonical old bundle is byte-identical to actual live
  Worker before release, so existing deployed fixes are not lost.
- Local self-review only; no private provider/subagent transfer.

## Deployment order

1. Commit on release branch, open PR and pass exact-head CI. No direct main push.
2. Deploy compatible Worker using `--keep-vars`; preserve compatibility date,
   all bindings/secrets, and existing data. No D1 migration.
3. Read back active deployment/version and compare runtime/binding metadata and
   downloaded script bundle. Prior version: `caec032c-8600-4970-910e-4a0c3c5b3e70`.
4. Merge exact approved PR head, wait for Pages workflow at merge SHA.
5. Verify live assets with no-cache byte comparison, SW `catet-v77`, external
   browser demo-v2/legacy-v1 and authenticated existing report GET only.
6. Verify report digest and original workspaces/cron definitions unchanged.

## Rollback

Worker: redeploy prior version `caec032c-8600-4970-910e-4a0c3c5b3e70` if this release
causes regressions. No data migration means no DB rollback. Frontend: revert this
PR through a new reviewed branch/PR and the normal Pages workflow; retain original
report/evidence, local drafts and all WIP.

## Deliberate remaining gates

The engine v2 publisher stays hard-blocked. This release does not make personal
work-pattern data Live; signed-in users keep their existing v1 report until a
separate approved publication. Unauthenticated demo is explicitly synthetic.
W37 is not a comparable baseline. Communication/focus/actual workload/feedback/
trends remain abstain without additional evidence. Publishing, cron and Telegram
are separate permissions.

## Post-release local publisher gate — 2026-10-15 (NOT deployed)

A later implementation-only session adds canonical GET ETag/protocol `cas-v1`,
mandatory exact `If-Match` for v2 and atomic SQL CAS on prior blob/updated_at.
Legacy v1 upsert remains but cannot downgrade v2; conditional rollback is allowed.
New Worker race/auth/precondition tests plus updated correction publisher harness
pass; full gate is 68/68 and legacy browser tests 3/3. No migration/auth policy,
frontend or existing cron changes. These local dirty edits are **not** part of
release `c33d3e2` / merge `3d5cd07`, have not been committed/deployed, and do not
publish the personal report. The engine refuses the old Worker protocol before PUT.
Engine proof: `state/t7-publisher-gate-2026-10-15/gate-proof.json`; detailed engine
doc: `docs/work-pattern-publisher-gate-verification-2026-10-15.md`.
