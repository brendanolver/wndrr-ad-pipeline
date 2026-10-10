# Triple Whale integration — findings and proposed architecture

Status: **investigation only. No Triple Whale code exists in this repo and none should be written until the open items below are
confirmed.** No credential is stored anywhere in the repo; nothing here needs a secret pasted into a chat or a commit.

Researched 10 Oct 2026. Evidence is graded:

- **Verified** — read directly from Triple Whale's official public-APIs repository (`github.com/Triple-Whale/triple-whale-public-apis`).
- **Reported** — appeared in search-engine excerpts of Triple Whale's official help centre / API reference pages
  (`kb.triplewhale.com`, `triplewhale.readme.io`). The research environment's network policy blocked those two hosts, so their full
  pages (request/response schemas, scope lists, rate-limit numbers) could **not** be read. Treat as "to confirm".
- **Not found** — looked for it, no official statement located.

## 1. Answers to the questions

| # | Question | Finding | Grade |
|---|----------|---------|-------|
| 1 | Does the subscription support the endpoints we need? | Personal API keys are offered to customers "with access to a Triple Whale subscription"; no tier is named. Triple Whale's current help-centre plan article lists **Foundation / Automate / Enterprise**, not "Advanced" (that name appears only in third-party pricing pages, so it is probably a legacy plan name). Nothing found ties API access to a tier. The practical test is whether **Settings → API Keys** (newer UI: Data → APIs) lets you generate a key. | Not found (tier) / Verified (subscription requirement) |
| 2 | How to obtain access? | Generate a personal API key in the Triple Whale app: Settings → API Keys → *Generate an API Key*, add a description, choose scopes. The key is shown **once**. (OAuth2 also exists but is for third-party apps that register with Triple Whale — not what we need.) | Verified (keys in UI, scopes) / Reported (menu path) |
| 3 | Authentication | API key sent in an `x-api-key` header to `https://api.triplewhale.com`. Key check: `GET /api/v2/users/api-keys/me` returns 200 for a working key. | Verified |
| 4 | Read-only possible? | Keys are scoped per endpoint, and the scopes reported are read scopes (**Summary Page: Read**, **Pixel Attribution: Read**; one third-party guide also mentions a *Data Out* scope). Creating a key with only read scopes is therefore possible. The summary / SQL / attribution calls are `POST` only because they carry a query body; they do not modify data. The **Metrics** endpoints (which write custom metrics *into* Triple Whale) are not in the API-key list and must never be used. | Verified (endpoint list) / Reported (scope names) |
| 5 | Campaign, ad set and ad-level reporting? | The two documented API-key endpoints are **not** ad-level reporting: *Summary Page* returns account-level KPIs; *get-orders-with-journeys-v2* returns **orders with their customer journeys** (we would have to aggregate by ad ourselves). Ad-level reporting is reachable through the **custom SQL endpoint** (`POST /api/v2/orcabase/dev/sql`, ClickHouse-flavoured SQL over Triple Whale's data model). Whether a personal API key (and which scope) may call the SQL endpoint is **not confirmed**. | Verified / Reported / **Open** |
| 6 | Purchases, CPA, revenue, ROAS, spend | Summary Page: top-level KPIs (spend, revenue, ROAS, orders …) over a date range — reported, schema not read. SQL: the docs steer ad/attribution queries to `pixel_joined_tvf` (spend is summed from it); `ads_table` is used for ad metadata. CPA is not a stored metric — derive it as spend ÷ attributed purchases. Exact column names are **not** verified. | Reported / **Open** |
| 7 | Meta campaign / ad set / ad IDs for matching | The Triple Whale data model has `campaign_id`, `adset_id` and `ad_id`; the docs describe `ad_id` as "the unique identifier assigned by the ad platform". That strongly suggests Meta's own ad id, which is exactly our `meta_ads.meta_ad_id`. **Not yet proven** for WNDRR's data — Triple Whale attributes through UTM / `fbadid` tagging, so ads without correct URL tags may attribute to no ad. | Reported / **Open** |
| 8 | Attribution models / dates to align | Triple Whale models: First Click, Last Click, Linear (Paid), Linear (All), **Triple Attribution**, Triple Attribution + Facebook views, **Total Impact** (modelled, includes post-purchase survey input). Click data is real-time; view data refreshes daily. Meta numbers in WNDRR are `omni_purchase` with **7d_click + 1d_view** (provisional). We must pick ONE Triple Whale model + window and label it; a like-for-like comparison with Meta is not possible with a different window. Also align: reporting timezone (WNDRR uses Australia/Sydney), currency (AUD), and the day an order is credited to (click date vs order date). | Reported / **Decision needed** |
| 9 | Rate limits, cost, history | Limits "vary by endpoint"; a 429 carries a retry delay header; guidance is exponential back-off and splitting wide date ranges. **No numbers found.** No API usage charge found (the Moby AI assistant has a monthly allotment — separate). Historical depth: **not found**. | Reported / Not found |

Also noted: Triple Whale offers a read-only **MCP** connection for AI tools. Triple Whale's own article says it must not be treated as API access, and it is not a fit for a server-side nightly sync, so it is not proposed here.

## 2. What is needed from Brendan (nothing is pasted into Claude)

1. In Triple Whale (you may need to be a store admin): **Settings → API Keys** (or **Data → APIs**) → **Generate an API Key**.
2. Description: `WNDRR Ad Pipeline — read only`. Tick **only read scopes**: *Summary Page: Read*, *Pixel Attribution: Read*, and the *Data Out / SQL read* scope if one is listed. Do **not** tick anything that writes (e.g. TW Metrics: Write / data-in).
3. Copy the key from the one-time popup straight into Railway — never into a chat, ticket, commit or `.env` file that is committed:
   Railway → the WNDRR project → the web service → **Variables** → **New Variable** →
   `TRIPLEWHALE_API_KEY` = *the key* (use the **Seal** option if offered so the value is hidden afterwards).
4. Add a second variable `TRIPLEWHALE_SHOP` = the shop identifier exactly as Triple Whale shows it for the WNDRR store.
5. Tell Claude only: "the two Railway variables are set". Claude will then run the read-only probe below. No existing variable (including `META_AUTO_SYNC`) changes.
6. Decide the attribution model + window to compare with Meta (see §1 row 8). Recommendation to discuss: the model WNDRR's team already uses to judge daily performance in Triple Whale, with a click window matching Meta's 7-day click as closely as Triple Whale allows.

If the key cannot be created, or the SQL scope is not available to personal keys, the ad-level comparison is blocked: only account-level (Summary Page) comparison remains possible, and ad-level would need Triple Whale support or their data-warehouse export (`Introduction to Data Warehouse Export` is listed in their reference — plan/cost unknown).

## 3. Read-only probe (first thing to run once the key exists — no schema change, nothing stored)

A throwaway script, not shipped, that makes four read calls and prints only non-secret summaries:

1. `GET /api/v2/users/api-keys/me` — key works, which scopes it holds.
2. One Summary Page call for yesterday — confirms spend / purchases / revenue / ROAS fields and the account timezone.
3. One SQL query for a single day of ad rows (ad id, ad set id, campaign id, spend, attributed orders and revenue for the chosen model) — confirms columns, the model/window parameters and the rate-limit headers.
4. Compare yesterday's Triple Whale `ad_id`s with `meta_ads.meta_ad_id` and Triple Whale spend with Meta spend for the same ads. The match rate decides whether per-ad comparison is reliable.

Pass criteria are written down before running: ≥ 95 % of Triple Whale spend maps to a known `meta_ad_id`, and per-ad spend agrees with Meta within a small stated tolerance. If not, we compare at campaign level only and say so on screen.

## 4. Proposed architecture (to build only after the probe passes)

- **Server-side only.** `src/lib/tripleWhaleClient.js`: a single read-only client with an **allow-list of endpoints** (the summary, SQL and `api-keys/me` calls — never `/tw-metrics/*`), `x-api-key` from `process.env.TRIPLEWHALE_API_KEY`, 429 handling with the returned retry delay + exponential back-off, request timeouts, and error messages that can never contain the key (redacted). The key is never sent to the browser, logged, or committed; tests assert the client source has no literal key and the frontend has no reference to it.
- **Local store (additive tables only):** `tw_ad_daily` (day, Meta `ad_id`, `adset_id`, `campaign_id`, spend, attributed purchases, attributed revenue, attribution model, window, fetched_at, unique on day + ad + model + window) and a small `tw_sync_runs` log. The dashboard reads **only** these tables — page loads never call Triple Whale — mirroring how Meta data works today.
- **Sync:** manual, bounded (one day or a short range per call, respecting limits), opt-in; not tied to `META_AUTO_SYNC`. Never run automatically until approved.
- **Joins:** exact `ad_id = meta_ads.meta_ad_id`; campaign/ad set exact-ID joins. No name matching.
- **Dashboard (side by side, every metric labelled with its source):**
  `Meta Purchases | TW Purchases`, `Meta CPA | TW CPA`, `Meta Purchase Value | TW Revenue`, `Meta ROAS | TW ROAS`, with Amount Spent (Meta) kept. Funnel badge, campaign line, thumbnails, filters and sorting stay. TW CPA = TW spend ÷ TW purchases computed from stored sums (never averaged).
- **No silent substitution.** Where Triple Whale has no row for an ad/day the TW cell shows "—" with a "no Triple Whale data" tooltip; it is never filled with the Meta figure. Until Triple Whale data is verified, the health colours keep judging **Meta CPA** and say so; a switch to TW CPA is a separate, explicit approval.
- **Tests:** client unit tests with recorded fixtures (no network), redaction tests, join/derivation tests, UI tests for the labelled columns and the missing-data cases.

## 5. Open items / risks

1. Whether a personal API key can call the SQL endpoint (and the scope name) — decides ad-level feasibility.
2. Exact column names for ad-level spend, attributed purchases and revenue, and how the attribution model / window is selected in the query.
3. Whether `ad_id` is Meta's id for WNDRR's ads (UTM/`fbadid` tagging coverage).
4. Rate-limit numbers and how far back history goes.
5. Plan tier vs API availability (confirm in-app or with Triple Whale support).
6. Model/window choice and timezone alignment — a business decision, not a technical one.
7. Triple Whale "Triple Attribution" can credit more revenue than native sales data because of overlapping attribution; totals will not reconcile to Meta and should not be forced to.
