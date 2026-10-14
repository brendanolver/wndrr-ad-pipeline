# Release process (agreed with WNDRR)

This is the standard workflow for every development task WNDRR has explicitly requested. `main` deploys to production on Railway, so the checks are not optional. Completing the release is part of the task: do not stop after implementation and do not ask for separate merge or deployment approval when every check passes.

## Standard workflow

1. Create a development branch from the current `main`.
2. Implement the requested change (only what was requested).
3. Run the appropriate unit, browser and database tests (`npm test` plus every browser / database suite that touches what changed).
4. Fix any regression the change introduced. The only failures allowed are the known baseline ones (`match-lib` 8, `match-auto` 20, `v4-lib` 2) and suites retired for a removed feature (see the QA notes). Anything new, or any change in those numbers, is a failure.
5. Record the change with `npm run bump -- "Short title" "What changed" ...` (see `docs/versioning.md`).
6. Commit the completed work (the working tree must be clean; never push to `main` from a branch with uncommitted changes).
7. Merge into `main` as a fast-forward once all checks pass. If `main` moved, bring it into the branch, re-run the checks, then merge. Never force-push, never rewrite history.
8. Push `main` to trigger the Railway deployment.
9. Verify the deployment: Railway reports success for that commit, then check the health endpoint and the reported version where the live app is reachable.
10. Report the release: the commit, the version, the test results, the Railway status, and anything that could not be verified (for example the live site, which the build environment may not be able to open). Report deployment success and live UI verification separately.

The automatic workflow applies only to development tasks that were explicitly requested. It is not permission to make unrequested product changes or to start unrelated releases.

## Stop and request approval (do not merge or deploy) when

* a destructive database change is required (anything that alters, deletes or rewrites existing data; additive, idempotent schema changes are fine);
* existing production records may be deleted or overwritten;
* recommendation or financial calculations would change materially beyond the approved scope;
* a critical regression remains unresolved, or a check could not be run;
* the release contains unexpected changes (files or behaviour beyond the request);
* `main` has diverged and cannot be safely fast-forwarded, or the change needs a force-push, a history rewrite, or resolving a real conflict between two versions of the same logic;
* the change would write to live ApparelMagic, Shopify or Meta records, or runs a bulk matching / catalogue / production-data job;
* the production deployment fails and recovery would need a potentially destructive action;
* WNDRR said not to merge this one, or the request is unclear about what should ship. An explicit instruction not to merge or deploy always overrides the standard workflow.

## Branches and deployment

* Only `main` deploys to production (Railway). Pushing a `batchN` development branch to `origin` does not deploy; the Railway trigger is configured in Railway, not in this repository (`railway.json` sets the build and start command only), so confirm it before relying on that.
* Every release records its version with `npm run bump` (see `docs/versioning.md`).

## Always

* Work is never pushed to `main` from a branch with uncommitted changes.
* Security stays as it is: no secrets, tokens or credentials in the repository, commits or reports; tests that write data use a local or isolated database, never production; Meta syncs, matching backlog jobs and writes to live ApparelMagic / Shopify / Meta are never run as part of a release check.
* A one-line summary of what shipped goes back to WNDRR after every merge, including anything that was not verified (for example the live site, which the build environment cannot open).
