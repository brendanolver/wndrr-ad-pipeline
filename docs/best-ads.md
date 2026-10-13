# Meta Performance: Performance vs Best Ads

* **Performance** = individual Meta ad analysis (every Meta Ad ID is its own row).
* **Best Ads** = unique creatives, with duplicate Meta ads grouped into one card.
* **Ad Matching** = creative identification and matching (unchanged).

## Performance (search engine for individual ads)
20 ads per page, numbered pagination and "Showing 1–20 of N ads". The whole matching dataset is paged in SQL (nothing is limited to 20 records). **Search** runs across the entire dataset: full ad name, exact Meta Ad ID, product name / code (Ad Matching classification) and creative / concept name (concept type or label), and returns to page 1 when search or any filter changes. Filters, sorting (default Amount Spent, highest first), summary cards, benchmarks, thumbnails, preview, date range, previous period and DPA exclusion are unchanged. **No grouping here**: "Copy" ads stay separate rows.

## Best Ads (unique creatives)
**Grouping rule** = the ad name with trailing copy suffixes removed, using exactly Ad Matching's rule (`src/lib/metaNameCopies.js` `normaliseAdName`): only a trailing `- Copy`, `– Copy 2`, `- Copy - Copy 2` (any dash, any capitalisation, repeated) is removed; the remainder must match exactly, so a different hook / concept / format / variation id (or a "Copy of ..." prefix) is a different creative, and an ad with no name is its own creative. The same rule is expressed in SQL (`creativeKeySql`) so grouping, ranking, paging and totals all run in the database; the unit test and `b15-db` check the two stay identical.

**No new tables and no stored grouping.** The group is derived at read time from `meta_ads.ad_name`; original names, ad IDs, matching records and attribution are never modified.

* Combined figures are sums of the member ads' stored sums (no double counting). CPA = spend / purchases and ROAS = purchase value / spend are derived from the sums, never averaged. Reach / Frequency are not combined (audience overlap); they stay on individual ads in Performance.
* Ranking (default Purchase Value, highest first; also Purchases, CPA lowest first, ROAS, Amount Spent) runs over the whole eligible set. Minimum spend (default $500, 0 allowed) applies to the creative's **combined** spend; CPA / ROAS also need a minimum number of combined purchases (default 5, editable).
* Ad-level filters (Funnel, Campaign, Status, Include DPAs) choose which Meta ads count towards a creative, so a card under a TOF filter shows only its TOF ads. Search chooses creatives: if any member ad matches (name, product, concept, Meta Ad ID) the creative is shown with all its counted ads.
* Cards: ranked, preview of the creative's biggest-spending ad (existing cover / preview behaviour), clean name, product, funnel badges (e.g. TOF + TOM), "N Meta ads", Active / Paused / Mixed, Purchase Value hero, Purchases, CPA, Amount Spent, ROAS. First 20 creatives, then Load more; the summary counts creatives ("Showing 20 of 142 creatives"). KPI totals cover the same creatives; Previous period is like for like.

## Creative detail
Clicking a card opens the existing Ad Preview modal (preview of the representative ad on the left). The right column shows the combined performance, **Performance by Funnel** (only funnels that ran: TOF / TOM / MOF, with ads, spend, purchases, CPA, purchase value, ROAS) and **every underlying Meta ad** with its original name, Meta Ad ID, funnel, campaign, status and metrics. "Preview" opens that ad's ordinary preview (with a way back to the creative), where View Ad on Meta is available. Endpoint: `GET /api/meta-performance/best-ads/creative` (admin only; same ad-level filters as the card).

## Large covers
Unchanged from the previous release: 600px covers requested lazily in batches and cached separately; videos play inline only from an already-cached playable file.
