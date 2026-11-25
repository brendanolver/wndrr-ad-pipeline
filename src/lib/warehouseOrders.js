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
async function weekItems(db, weekStart) {
  const { rows } = await db.query(
    `SELECT COALESCE(NULLIF(trim(spi.product_name), ''), s.name, s.style_code) AS product_name, s.style_code, spis.colour_label, spis.size
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
  return rows.map((r) => ({
    productName: String(r.product_name || '').slice(0, 200),
    styleNumber: r.style_code ? String(r.style_code).trim() : null,
    colour: r.colour_label ? String(r.colour_label).slice(0, 120) : null,
    size: r.size && String(r.size).trim() ? String(r.size).trim().slice(0, 20) : null,
    quantity: 1,
  }));
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

module.exports = { settings, weekItems, callTuesday, TuesdayUnreachable, validWeek, validDate, PATH };
