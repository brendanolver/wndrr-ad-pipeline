# Launch status and product role (Batch 13)

This is the investigation record for "High Stocks recommends products that have not launched". Everything below is graded by how it was established.

## 1. What ApparelMagic actually exposes (read from the code that reads it)

* The app reads one crawl of ApparelMagic `GET /products`. The fields it keeps per **style** (one style = one colourway; the 8-character product code groups colourways) are: `style_number`, `description` (name and colour), images, `mid_code`, `group`, `category`, `color_code`, `size_range_id`.
* **`mid_code` is WNDRR's official product launch date. This was CONFIRMED by WNDRR (12 Oct 2026).** History, for the record: Batch 13 first asserted it as "confirmed in production" on the strength of a single old commit message (`2f6b076`) that cited the Demand Planning repo; that was not independent evidence, so a follow-up change treated the field as unverified until WNDRR confirmed it directly. It is now confirmed and the setting `launch_date_verified` defaults to ON. It is held **per style (= colourway)**, as free text; `0` or blank means "none".
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

**This looked like a conflict with the statement that these five have not launched, and it is explained by the confirmed rule:** Shopify availability and sales are not the official launch (section 4a). Shopify has all five ACTIVE and published with steady weekly sales since August, and the stock figures equal the ones shown in High Stocks exactly. Either (a) the team means a different kind of "launch" (for example a campaign or hero launch) that does not stop the product being on sale, (b) these were set live early, or (c) the five are a different, genuinely unreleased set of colourways or styles. This cannot be settled from code. **What decides it:** the official `mid_code` date. A future date excludes them whatever Shopify shows; if ApparelMagic holds a passed or missing date for a product the team considers unlaunched, correct the date in ApparelMagic (or set a manual *Not launched* status).

## 3. Why Batch 12 let them through

Batch 12 judged a colourway launched when **any** of: a past ApparelMagic date, a past Upcoming Drop, or **10 or more units sold in the sales history** (rule 4). A date in the future or a future Upcoming Drop was the only thing that excluded a product, and the five products are being sold (Shopify shows 39-174 units each), so unless ApparelMagic holds a *future* date for them, rule 4 classified them as launched. The earlier High Stocks code had the same blind spot: with no launch date on record it treated the product as eligible. Two further weaknesses were fixed at the same time: an untidy date such as `1 Nov` could be parsed into a past year by a permissive fallback, and a planned launch date that had just passed with no sales was treated as proof of launch.

## 4. The rules now (see `src/lib/launchStatus.js`)

1. A person's manual status wins.
2. Shopify, only when supplied (not configured today): DRAFT = not launched, ARCHIVED = discontinued; ACTIVE and published corroborates a launch but never overrides a future date.
3. An Upcoming Drop dated in the future = not launched (its creative is handled in Upcoming Drops).
4. The official ApparelMagic launch date (`mid_code`): future = not launched, **always** (neither a published Shopify listing nor sales history can override it); **unreadable = unknown** (never guessed; years outside 2015-2100 and impossible dates count as unreadable); past = launched. (An optional extra check, `launch_settle_days`, can send a date that passed only a few days ago with nothing sold yet to verification; it is OFF by default now that the date is official.)
5. CORE product group with no future date = launched (an established range).
6. A past Upcoming Drop = launched.
7. **Sales alone do not prove a launch** (pre-launch, staff and seeding orders look identical). They only count when the setting *Sales alone confirm a launch* is switched on (off by default).
8. Anything else is **unknown**: kept out of every recommendation, listed under **"Products requiring launch verification"** (High Stocks and the Weekly Plan) with what was checked, and one click confirms it launched or marks it not launched. Stock, zero sales and "last creative: never" are never evidence.

Colourways are judged one by one; a product with some launched and some unlaunched colourways is launched and the unlaunched colours are noted.

**Why this is not a manual-classification job:** a product needs a person only when ApparelMagic has no readable date, it is not in the CORE group, and there is no Upcoming Drop. Products with a past date, a future date, an Upcoming Drop, or the CORE group are classified automatically. The verification list is ordered by stock, and each row shows the evidence.

## 4a. How the confirmed launch date is used (the rules, as implemented)

Setting **Settings → Planning → Launch status → "ApparelMagic mid_code is the OFFICIAL launch date"** (`launch_date_verified`) is **ON by default**. Existing production settings are untouched: nothing is written to the database, a stored value is respected exactly as stored (an explicit `0` would switch the confirmation off), and the new default simply applies where no value is stored. The optional "settle" check (`launch_settle_days`) is now **0 = off** by default, because the date is official: a date that has passed means launched.

| `mid_code` holds | Result |
| --- | --- |
| a **future** date | **Not launched.** Left out of High Stocks, Core and ordinary Weekly Plan recommendations (reported, never silently dropped; handled in Upcoming Drops). Neither Shopify publication/ACTIVE status nor sales history overrides it |
| a **passed** date | **Launched** (subject to a manual override) |
| missing (blank / `0`) | CORE group → launched; otherwise the existing evidence (manual status, Shopify where supplied, a past drop); with none: **verification workflow** |
| invalid / unreadable text | **Verification workflow** ("Products requiring launch verification"), never guessed |

* Evaluated **per colourway**: a product with a launched White and a future Navy is launched; the Navy colourway is left out and named.
* A **manual launch status** still wins in both directions (a person can mark a future-dated product launched, or a passed one not launched). High Stocks' older date pre-filter was changed so that a manual "launched" status is honoured there too.
* Shopify, where supplied, can only *add* proof for products with no date, or mark DRAFT = not launched / ARCHIVED = discontinued. It never turns a future official date into a launch.
* If the confirmation ever needs withdrawing, set `launch_date_verified` to 0: a passed date then stops counting as proof and those products go to verification.

## 4b. What Shopify showed (read-only, 12 Oct 2026) about the five products, and what it means now that mid_code is official

These are **facts from Shopify**; what the team *means* by "launched" is not in any data source we can read.

| Colourway (style code) | Shopify published (UTC) | Planned delivery month (`custom.delivery_month`) | First sales week |
| --- | --- | --- | --- |
| Slammed Box Fit Tee Black/White (W26HA002) | 10 Aug 2026 | Aug-26 | w/c 10 Aug |
| Revival Heavy Weight Tee Faded Black/Moon Grey (W26HA009) | 10 Aug 2026 | Aug-26 | w/c 10 Aug |
| Loan Shark Box Fit Tee Black/White (W26IA006) | 24 Aug 2026 23:02 (25 Aug AEST) | **Sep-26** | w/c 24 Aug (first order 27 Aug) |
| Hexed Box Fit Tee Navy/White (W26IA004) | 24 Aug 2026 23:01 | **Sep-26** | w/c 24 Aug |
| Faction Box Fit Tee Faded Black (W26IA020) | 31 Aug 2026 | **Sep-26** | w/c 31 Aug |

* **No sale occurred before a colourway's publish date.** First sales start the week it is published. So these are not pre-launch leaks; they are normal public sales of products that are live on the store.
* **Channel mix since 1 Aug (556 orders across the five): ~95% Online Store**, plus Redo (returns/exchange app), Shop, and Facebook & Instagram. No POS, wholesale, draft-order or staff channel. In the first 12 Loan Shark orders sampled: all `web` or Facebook channel, none test orders, two used discount codes, none carried staff or seeding tags (this is a sample, not an audit of all 556).
* **It is not pre-order selling.** Inventory policy is DENY (cannot sell beyond stock) and stock existed.
* **Shopify carries its own planned delivery month**, and it is encoded in the style code: the letter after the year (`W26` + **G/H/I/K**...) matches `custom.delivery_month` (G=Jul, H=Aug, I=Sep, K=Nov, checked on 25 products across G, H, I and K; the `W26K...` Nov-26 products are all unpublished drafts). Loan Shark, Hexed and Faction are **Sep-26** products that went on sale in late August, i.e. **before their planned delivery month**: strong evidence of **early availability**. Slammed and Revival Heavy Weight Tee are **Aug-26** products published in August, which does not on its face explain "not launched".
* **Colourways differ**: for example Revival Hood Sweat Moon Grey (W26GE023, Jul-26) published 30 Jun, while Black/Charcoal (W26HE016, Aug-26) published 22 Jul. Per-colourway judgement is therefore required, and the app already does it.
* Older W25 Revival/Hexed drafts (Black, Charcoal, Baby Blue) are unrelated last-year styles.

**What this means with the confirmed rule.** Shopify publication and sales are early-availability facts, not the launch date. If ApparelMagic's `mid_code` for these colourways is in the future, the app now keeps them out whatever Shopify shows; if it is in the past, they are launched. The real `mid_code` values could not be read from the build environment: run **Settings → Planning → "Check a product's launch evidence"** (tick "Include raw ApparelMagic fields") for each of the five in production to see them. The tests use hypothetical dates and prove the rule, not the data.

**What this does and does not establish.** It establishes that the five are *on sale and selling* and that for three of them that happened ahead of Shopify's own planned delivery month. It does **not** establish an *official launch date* for any of them. The distinction the team draws ("official launch" vs "available") is real in the data: **publish date**, **planned delivery month**, **sales history** and **official launch** are four different things, and only the first three are readable today.

## 5. Product role is separate from creative priority

Existing catalogue terminology: ApparelMagic `group` (CORE or not), `category` (product type), Upcoming Drops, and the seasonality read. Shopify tags (for example `NEW ARRIVALS`, `WINTER26`, `FULL PRICED STYLES`) and product types exist, but Shopify is not connected. No new classification was invented. The **role** shown beside each product, built only from those:

* **Core**: in the ApparelMagic CORE group.
* **New drop**: launched within the last 60 days (setting) by ApparelMagic date or Upcoming Drop.
* **Seasonal**: the seasonality read shows an in / coming into / out of season pattern.
* **Range**: none of the above.

A product can carry several roles. The role never changes the priority: a seasonal product can be Shoot now, a new drop can deserve more creative after launch, a Core product can be Monitor when its creative is healthy. The Planning **Core** step now says plainly that it lists creative opportunities for products in the Core range only, not every product that needs creative.

## 6. Rollout and safety

* No migration was needed for launch status (the Batch 12 `product_launch_overrides` table is used unchanged). New settings live in the existing `creative_planning_config` JSON; stored values are untouched.
* Expect the verification list to hold only products with a missing or unreadable `mid_code` (and no CORE group, past named drop or manual status): they previously slid through on sales alone. Review it once; confirmations are stored as manual statuses.
* To keep the Batch 12 behaviour deliberately, switch on *Sales alone confirm a launch* in Settings → Planning → Launch status.
