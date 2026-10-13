# Release process (agreed with WNDRR)

Changes are merged into `main` automatically once they pass the checks below, without waiting for a separate "merge" instruction. `main` deploys to production on Railway, so the checks are not optional.

## Every change

1. Work on a branch from the latest `main`.
2. Run `npm test` and every browser / database suite that touches what changed. The only failures allowed are the known baseline ones (`match-lib` 8, `match-auto` 20, `v4-lib` 2). Anything new, or any change in those numbers, is a failure.
3. Record the change with `npm run bump -- "Short title" "What changed" ...` (see `docs/versioning.md`). The version in the sidebar is how WNDRR sees that something shipped.
4. Merge into `main` as a fast-forward and push. Never force-push, never rewrite history. If `main` moved, bring it into the branch, re-run the checks, then merge.
5. Check the Railway deployment for that commit reports success, and report: the commit, the version, the test results and anything that could not be verified.

## Branches and deployment

* Only `main` deploys to production (Railway). Pushing a `batchN` development branch to `origin` does not deploy; the Railway trigger is configured in Railway, not in this repository (`railway.json` sets the build and start command only), so confirm it before relying on that.
* A batch can be held for approval: the standing rule above does not override an explicit instruction not to merge. Batch 27 is such a batch: it lives on `origin/batch27-planning-intelligence` and is not merged.
* Every release records its version with `npm run bump` (see `docs/versioning.md`).

## Stop and ask first (do not merge automatically) when

* a test fails beyond the baseline, or a check could not be run;
* a database change is not purely additive (anything that alters, deletes or rewrites existing data);
* the change would write to live ApparelMagic, Shopify or Meta records, or runs a bulk matching / catalogue / production-data job;
* the change needs a force-push, a history rewrite, or resolving a real conflict between two versions of the same logic;
* WNDRR said not to merge this one, or the request is unclear about what should ship.

## Always

* Work is never pushed to `main` from a branch with uncommitted changes.
* A one-line summary of what shipped goes back to WNDRR after every merge, including anything that was not verified (for example the live site, which the build environment cannot open).
