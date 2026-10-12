# App version and version history

The sidebar shows the version at the bottom ("VER. 1.0.0"). Clicking it opens the version history: every version, newest first, with its date, a title and what changed.

## Numbering

Three digits, each 0 to 9, counting up like an odometer. A change always bumps the **last** digit; a digit that would pass 9 goes back to 0 and carries into the one before it.

    1.0.0 -> 1.0.1 -> ... -> 1.0.9 -> 1.1.0 -> ... -> 1.9.9 -> 2.0.0

(This is the team's rule. It is not semantic versioning: the numbers say "this many changes", not "how big".)

## Recording a change

Every change that is merged gets its own version. Before merging, run:

    npm run bump -- "Short title" "What changed" "Another thing that changed"

This adds the next version to `version-history.json` (newest first, dated in Sydney time) and sets the same version in `package.json`. Nothing is pushed or deployed by the command. A unit test (`test/version.test.js`) fails if the history is malformed, skips a number, or if `package.json` and the history disagree, so the two cannot drift apart.

## Where it comes from

* `version-history.json` is the single source of truth (the version shown is its newest entry).
* `GET /api/version` returns `{ version, build, scheme, entries }` to any signed-in user. `build` is the short commit the host reports (Railway), when available, and is shown at the bottom of the history.
* Code: `src/lib/version.js` (numbering + loading), `src/routes/version.js`, `scripts/bump-version.js`, `public/app.js` (sidebar label + modal).

## Limits

Version 1.0.0 is the starting point. Work done before it was not versioned one change at a time, so the history cannot say when each earlier change happened (the 1.0.0 entry summarises it).
