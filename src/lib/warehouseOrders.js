'use strict';
// Warehouse orders for the weekly Shoot Plan (v1.9.5, WNDRR 2026-11-25: "add this ordering feature into ApparelMagic ... it can go under WNDRR SHOOT STOCK").
//
// The samples a week's Shoot Plan asks the warehouse for (every selected colourway NOT marked as already in the office: the same rows as the Warehouse Pick List
// CSV) are sent as ONE ApparelMagic order under the WNDRR SHOOT STOCK customer, with Customer PO "AD SHOOT <needed-by date>" ("#2" and up for later orders of
// the same week). This app NEVER writes to ApparelMagic itself (its ApparelMagic client stays GET-only, see test/noWritesGuard.test.js): it hands the list to
// TUESDAY (brendanolver/wndrrtuesday), which places the order through the same checks it uses for its own shoot orders (stock, no double orders, ApparelMagic's
// copy read back) and keeps the record. Tuesday works out what is still to order, so this module always sends the week's whole list.
//
// The list is read from this app's database on the server for every call: the browser only says which week, the needed-by date and (to place) the fingerprint of
// what it was shown, so what is ordered is always exactly the saved plan.
//
// Settings (Railway variables, never in the repository): TUESDAY_URL (e.g. https://tuesday.example.com) and TUESDAY_ORDERS_KEY (the same value as Tuesday's
// CREATIVE_PIPELINE_API_KEY). Either missing = ordering is off and the page says so; the CSV export keeps working.

const { autoLinkedSql } = require('./shootPlanSelection');
const apparelmagic = require('./apparelmagic');

const WEEK_RE = /^\d{4}-\d{2}-\d{2}$/;
const PATH = '/api/creative-pipeline/shoot-orders';
// A review is a few database reads and a stock look; placing also waits for ApparelMagic to create the order and for Tuesday to read it back.
const TIMEOUTS = { review: 30000, place: 120000, check: 60000, release: 60000 };

function settings(env = process.env) {
  const url = String(env.TUESDAY_URL || '').trim().replace(/\/+$/, '');
  const key = String(env.TUESDAY_ORDERS_KEY || '').trim();
  return { url, key, configured: /^https?:\/\//.test(url) && key.length >= 32 };
}

// The week's warehouse samples, one line per selected colourway that is not already in the office. Same rule as the page's Warehouse Pick List (app.js
// shootPlanWarehouseRows): products the plan only links automatically are not part of the selection, and a product marked "in office" as a whole counts for every
// colourway. One piece each, as the CSV export always has.
async function weekRows(db, weekStart) {
  const { rows } = await db.query(
    `SELECT spi.id AS item_id, s.id AS style_id, COALESCE(NULLIF(trim(spi.product_name), ''), s.name, s.style_code) AS product_name, s.style_code, spis.colour_label, spis.size
     FROM shoot_plan_items spi
     JOIN shoot_plan_item_styles spis ON spis.shoot_plan_item_id = spi.id
     JOIN styles s ON s.id = spis.style_id
     WHERE spi.week_start = $1::date
       AND NOT ${autoLinkedSql('spi')}
       AND spi.stock_status <> 'in_office'
       AND NOT COALESCE(spis.in_office, false)
     ORDER BY spi.created_at ASC, spi.id ASC, s.style_code ASC`,
    [weekStart]
  );
  return rows;
}

// What Tuesday is sent: exactly the saved plan. (The colour is the plan's own label only, never a name looked up from ApparelMagic, so the list Tuesday checks
// and the list it places can't differ just because a catalogue lookup did.)
function toItem(r) {
  return {
    productName: String(r.product_name || '').slice(0, 200),
    styleNumber: r.style_code ? String(r.style_code).trim() : null,
    colour: r.colour_label ? String(r.colour_label).slice(0, 120) : null,
    size: r.size && String(r.size).trim() ? String(r.size).trim().slice(0, 20) : null,
    quantity: 1,
  };
}

async function weekItems(db, weekStart) {
  return (await weekRows(db, weekStart)).map(toItem);
}

// The same SKU key Tuesday uses: the style code then the size, upper case, no spaces.
const skuKey = (styleCode, size) => `${String(styleCode || '').trim().toUpperCase()}${String(size || '').trim().toUpperCase()}`.replace(/\s+/g, '');

// One row per sample for the page (v1.9.6): which sample it is (to save a new size to), a readable colour (the plan's label, else ApparelMagic's colour name,
// else the style code), the sizes that colour comes in and the warehouse stock per size, for the size picker. `am` is planningData.fetchAmData()'s result;
// with ApparelMagic unavailable the sizes list is empty and the stock is unknown.
function toSample(r, am) {
  const code = r.style_code ? String(r.style_code).trim() : '';
  const sizing = am && am.amDetails ? apparelmagic.resolveStyleSizing(am.amDetails, am.amSizeRanges, code) : { sizes: [] };
  const bySize = am && am.amStock && am.amStock.sizes && am.amStock.sizes.get ? am.amStock.sizes.get(code) : null;
  const sizeStock = bySize && bySize.size ? Object.fromEntries([...bySize.entries()].map(([k, v]) => [String(k).toUpperCase(), Number(v) || 0])) : null;
  const colour = (r.colour_label && String(r.colour_label).trim()) || apparelmagic.resolveColourName(am && am.amDetails, code) || apparelmagic.resolveColourLabel(am && am.amDetails, code) || null;
  return {
    item_id: r.item_id,
    style_id: r.style_id,
    product_name: String(r.product_name || ''),
    style_code: code,
    colour,
    size: r.size && String(r.size).trim() ? String(r.size).trim() : null,
    sizes: (sizing && sizing.sizes) || [],
    size_stock: sizeStock,
    to_order: false,
  };
}

// Which samples are still to order. Tuesday says how many pieces of each SKU are still to order (review.toOrder); the newest samples of that SKU are the ones
// not yet on an order, so they are marked, newest first. Everything else is already on one of the week's orders.
function markToOrder(samples, toOrder) {
  const left = new Map();
  for (const l of toOrder || []) left.set(skuKey(l.styleNumber, l.size), (left.get(skuKey(l.styleNumber, l.size)) || 0) + (Number(l.quantity) || 0));
  for (let i = samples.length - 1; i >= 0; i -= 1) {
    const k = skuKey(samples[i].style_code, samples[i].size);
    if ((left.get(k) || 0) > 0) {
      samples[i].to_order = true;
      left.set(k, left.get(k) - 1);
    }
  }
  return samples;
}

class TuesdayUnreachable extends Error {}

// One call to Tuesday. Returns Tuesday's JSON ({ ok, ... }). A network failure, a timeout or an answer that isn't JSON throws TuesdayUnreachable: for "place" that
// is an UNKNOWN outcome (Tuesday may have placed it), which the route reports as such rather than as "nothing happened".
async function callTuesday(action, body, deps = {}) {
  const { url, key, configured } = settings(deps.env);
  if (!configured) return { ok: false, notConfigured: true, error: "Sending orders to the warehouse isn't switched on yet. Use Export CSV instead." };
  const fetchImpl = deps.fetchImpl || ((...a) => fetch(...a));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), deps.timeoutMs || TIMEOUTS[action] || 30000);
  let res;
  try {
    res = await fetchImpl(`${url}${PATH}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ action, ...body }),
      signal: controller.signal,
    });
  } catch (err) {
    throw new TuesdayUnreachable(err && err.name === 'AbortError' ? 'Tuesday took too long to answer' : 'Tuesday could not be reached');
  } finally {
    clearTimeout(timer);
  }
  let data = null;
  try {
    data = await res.json();
  } catch (e) {
    throw new TuesdayUnreachable(`Tuesday answered with something unexpected (status ${res.status})`);
  }
  if (res.status === 401) return { ok: false, error: "Tuesday didn't accept this app's key. Tell Brendan: the warehouse link needs its key checked." };
  if (res.status === 503) return { ok: false, notConfigured: true, error: (data && data.error) || "Tuesday isn't ready to take warehouse orders yet." };
  if (!data || typeof data !== 'object') throw new TuesdayUnreachable(`Tuesday answered with something unexpected (status ${res.status})`);
  return data;
}

const validWeek = (w) => typeof w === 'string' && WEEK_RE.test(w);
const validDate = (d) => typeof d === 'string' && WEEK_RE.test(d);

module.exports = { settings, weekRows, weekItems, toItem, toSample, markToOrder, skuKey, callTuesday, TuesdayUnreachable, validWeek, validDate, PATH };
