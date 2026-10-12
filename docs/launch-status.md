# Launch status and product role (Batch 13)

This is the investigation record for "High Stocks recommends products that have not launched". Everything below is graded by how it was established.

## 1. What ApparelMagic actually exposes (read from the code that reads it)

* The app reads one crawl of ApparelMagic `GET /products`. The fields it keeps per **style** (one style = one colourway; the 8-character product code groups colourways) are: `style_number`, `description` (name and colour), images, `mid_code`, `group`, `category`, `color_code`, `size_range_id`.
* **`mid_code` is WNDRR's Launch Date.** WNDRR repurposes it (confirmed in production in the Demand Planning app, and relied on for Upcoming Drops suggestions). It is **per style / colourway**, free text, and `0` or blank means "none".
* **There is no product status, release date or available-from field that the app reads.** Nothing was assumed to exist. An inventory receipt date, purchase order date or warehouse arrival date is **not** a launch date and is never used as one.
* `group` = `AA CORE STYLES` / `ACCESSORIES CURRENT` marks the CORE range; `category` is the product type (Accessories are excluded from ad planning).
* *Not verified, and cannot be from the build environment:* the live ApparelMagic records of the five named products. The build environment has no ApparelMagic credentials. **The new read-only check (Settings → Planning → "Check a product's launch evidence", tick "Include raw ApparelMagic fields") shows, in production, exactly what ApparelMagic holds for any product, including every date-like or status-like field its record carries**, so the question "what does ApparelMagic say about Loan Shark?" can be answered in seconds without anyone guessing.

## 2. What Shopify shows for the five products (read-only, through the Shopify connector available to this session; not an app integration)

Shopify credentials are still **not** configured in production, and none were added. These reads were made with the existing connector, GET-style queries only.

| Product | Shopify status | Published | Units sold in Shopify since Aug 2026 | Shopify stock (matches the High Stocks figure) |
| --- | --- | --- | --- | --- |
| Loan Shark Box Fit Tee (Black, White) | ACTIVE, tag NEW ARRIVALS | 24 Aug 2026 (13 publications) | 57 (first sales week of 24 Aug) | 133 + 158 = 291 |
| Revival Heavy Weight Tee (Faded Black, Moon Grey) | ACTIVE | on sale | 174 | 170 + 113 = 283 |
| Slammed Box Fit Tee (Black, White) | ACTIVE | on sale | 161 | 108 + 127 = 235 |
| Hexed Box Fit Tee (Navy, White) | ACTIVE | on sale | 129 | 108 + 100 = 208 |
| Faction Box Fit Tee (Faded Black) | ACTIVE | on sale | 39 | 104 |

(Older Shopify drafts exist for last year's Revival and Hexed styles, W25 style codes; those are separate and unrelated to the current colourways.)

**This conflicts with the statement that these five have not launched.** Shopify has all five ACTIVE and published with steady weekly sales since August, and the stock figures equal the ones shown in High Stocks exactly. Either (a) the team means a different kind of "launch" (for example a campaign or hero launch) that does not stop the product being on sale, (b) these were set live early, or (c) the five are a different, genuinely unreleased set of colourways or styles. This cannot be settled from code. **Decision for the team:** if they are meant to be treated as not launched, mark each *Not launched* in the verification list (or add a manual status), or give them a future launch date in ApparelMagic; the app will then exclude them.

## 3. Why Batch 12 let them through

Batch 12 judged a colourway launched when **any** of: a past ApparelMagic date, a past Upcoming Drop, or **10 or more units sold in the sales history** (rule 4). A date in the future or a future Upcoming Drop was the only thing that excluded a product, and the five products are being sold (Shopify shows 39-174 units each), so unless ApparelMagic holds a *future* date for them, rule 4 classified them as launched. The earlier High Stocks code had the same blind spot: with no launch date on record it treated the product as eligible. Two further weaknesses were fixed at the same time: an untidy date such as `1 Nov` could be parsed into a past year by a permissive fallback, and a planned launch date that had just passed with no sales was treated as proof of launch.

## 4. The rules now (see `src/lib/launchStatus.js`)

1. A person's manual status wins.
2. Shopify, only when supplied (not configured today): DRAFT = not launched, ARCHIVED = discontinued; ACTIVE and published corroborates a launch but never overrides a future date.
3. An Upcoming Drop dated in the future = not launched (its creative is handled in Upcoming Drops).
4. An ApparelMagic launch date: future = not launched; **unreadable = unknown** (never guessed; years outside 2015-2100 and impossible dates count as unreadable); past = launched, unless it passed fewer than 21 days ago (configurable) with nothing sold yet, in which case it is *unknown* ("a planned date passing does not prove it went live").
5. CORE product group with no future date = launched (an established range).
6. A past Upcoming Drop = launched.
7. **Sales alone do not prove a launch** (pre-launch, staff and seeding orders look identical). They only count when the setting *Sales alone confirm a launch* is switched on (off by default).
8. Anything else is **unknown**: kept out of every recommendation, listed under **"Products requiring launch verification"** (High Stocks and the Weekly Plan) with what was checked, and one click confirms it launched or marks it not launched. Stock, zero sales and "last creative: never" are never evidence.

Colourways are judged one by one; a product with some launched and some unlaunched colourways is launched and the unlaunched colours are noted.

**Why this is not a manual-classification job:** a product needs a person only when ApparelMagic has no readable date, it is not in the CORE group, and there is no Upcoming Drop. Products with a past date, a future date, an Upcoming Drop, or the CORE group are classified automatically. The verification list is ordered by stock, and each row shows the evidence.

## 5. Product role is separate from creative priority

Existing catalogue terminology: ApparelMagic `group` (CORE or not), `category` (product type), Upcoming Drops, and the seasonality read. Shopify tags (for example `NEW ARRIVALS`, `WINTER26`, `FULL PRICED STYLES`) and product types exist, but Shopify is not connected. No new classification was invented. The **role** shown beside each product, built only from those:

* **Core**: in the ApparelMagic CORE group.
* **New drop**: launched within the last 60 days (setting) by ApparelMagic date or Upcoming Drop.
* **Seasonal**: the seasonality read shows an in / coming into / out of season pattern.
* **Range**: none of the above.

A product can carry several roles. The role never changes the priority: a seasonal product can be Shoot now, a new drop can deserve more creative after launch, a Core product can be Monitor when its creative is healthy. The Planning **Core** step now says plainly that it lists creative opportunities for products in the Core range only, not every product that needs creative.

## 6. Rollout and safety

* No migration was needed for launch status (the Batch 12 `product_launch_overrides` table is used unchanged). New settings live in the existing `creative_planning_config` JSON; stored values are untouched.
* Expect the verification list to be non-empty on first load: every product without a readable date, CORE membership or drop that previously slid through on sales will appear there. Review it once; confirmations are stored as manual statuses.
* To keep the Batch 12 behaviour deliberately, switch on *Sales alone confirm a launch* in Settings → Planning → Launch status.
