# Meta Performance: funnel filter and per-funnel benchmarks

## Funnel checkboxes (Performance > Ad Performance)
TOF / TOM / MOF checkboxes replace the "All funnels" dropdown. All three are selected by default; any combination can be chosen, "Select all" restores them, and the toolbar shows "n of 3 selected". The choice is remembered in the browser (per viewer) and filters **only the Ad Performance table** (`GET /api/meta-performance/ads?funnels=TOF,TOM`, or `funnels=none`). Nothing is sent when all three are ticked, so that is the complete table (including ads whose campaign name has no TOF / TOM / MOF). The summary cards, Best Ads and Ad Matching are not affected. Status, campaign, search, DPA, sorting and paging combine with it, and paging returns to page 1 when it changes. With nothing selected the table says so and offers Select all.

## Benchmarks (Settings > Meta Performance)
This extends the existing benchmark system (table `meta_performance_benchmarks`, same audit history, same 20 % rule); there is no second system.

* One benchmark = one funnel + measure (+ optional reporting window). **Measures:** every table measure except Amount Spent and Purchases: CPA, Purchase Value, ROAS, Adds to Cart, Cost / ATC, Outbound CTR, CPM, Reach, Frequency. Lower is better for CPA, Cost / ATC, CPM and (usually) Frequency; higher for the rest. Purchase Value and Adds to Cart are totals for the period, so give them a reporting window that matches the period length. Each funnel has its own; they are never combined, averaged or borrowed.
* **Direction:** CPA and CPM lower is better; ROAS, Outbound CTR and Reach higher is better; Frequency lower is better, or an **acceptable range** (optional "lowest acceptable" + "highest acceptable"; green inside, orange within the tolerance outside either end, red beyond).
* **Unset = neutral.** A measure with no active benchmark for an ad's funnel is never coloured, and an ad with an unknown / mixed funnel is never coloured. No values are invented: the only pre-existing targets (MOF CPA <= $60, TOF Frequency < 2 for 3-5 day periods) are preserved exactly.
* **Each row is judged by its own funnel.** Showing all three funnels together keeps every row's colour tied to its own funnel's benchmark.
* **Settings page (redesigned):** a heading, a compact green / orange / red colour guide, then one section per funnel (TOF Top of Funnel, TOM Top of Mid, MOF Middle of Funnel) with "n of 9 benchmarks set" and nine cards (CPA, Purchase Value, ROAS, Adds to Cart, Cost / ATC, Outbound CTR, CPM, Reach, Frequency). A card shows the saved target (or a dash), which side is good, its reporting window(s) and "+ Set target" / "Edit target →" ("+ Add window" adds another reporting window for the same measure; several windows are listed inside the card). A grey dot means not set; a subtle purple dot means set (never green).
* **Editing drawer** (right side): target type (lower / higher is better, or an acceptable range for Frequency), target, reporting window, orange tolerance, "exactly on target counts as green", and a live colour preview that mirrors the server rule (lower, higher and range). Cancel / Save Benchmark; for an existing benchmark a subtle Turn off and Remove (with confirmation). It uses the same API, validation (for example duplicate windows are refused) and audit history as before.
* **Change history** is a collapsed section at the bottom: what changed (added / changed / removed), previous → new value, who and when. No history is deleted.
* "How benchmarks work" holds the detailed explanation instead of permanent text.

## Green only (highlight a threshold)
For a number you want to notice rather than a target you can miss (typically **Reach**, e.g. "highlight green at 20,000 or more"), choose **Colours: Green only** in the editor (the default for a new Reach benchmark). The value is green when it meets the target and has no colour otherwise: never orange or red. Available for every measure and for Frequency ranges; stored as `highlight_only`.

## Red only (highlight the bad ones)
Choose **Colours: Red only** to flag just the ads that miss a target: a value is red when it misses the target by more than the tolerance and has no colour otherwise (never green or orange). The tolerance field becomes "Red when it misses by more than"; use 0% to flag anything that misses the target. Stored as `highlight_bad_only` (mutually exclusive with green only).

## Data model (additive)
`meta_performance_benchmarks`: the metric column is widened (VARCHAR 12 to 24) and its check lists the nine measures (existing rows untouched) and an optional `target_min` column holds a Frequency range's lower bound, `highlight_only` (default false) marks a green-only benchmark, and `highlight_bad_only` (default false) a red-only one. No data is deleted or rewritten.
