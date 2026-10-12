// What a launch decision needs from the local database besides ApparelMagic: the Upcoming Drops each style belongs to, and the manual launch-status overrides a
// person has set. Read-only. (Moved out of the weekly plan loader in Batch 14: it is shared by Core, High Stocks and the opportunity engine.)
async function loadLaunchContext(db, styleCodes) {
  const drops = new Map();
  const overrides = new Map();
  try {
    const r = await db.query(`SELECT s.style_code, d.name, to_char(d.launch_date, 'YYYY-MM-DD') AS launch_date FROM styles s JOIN drops d ON d.id = s.drop_id WHERE s.style_code = ANY($1::text[])`, [styleCodes]);
    r.rows.forEach((x) => drops.set(x.style_code, { name: x.name, launch_date: x.launch_date }));
  } catch (e) { /* drops unavailable: launch status simply has less evidence */ }
  try {
    const r = await db.query(`SELECT DISTINCT ON (product_code) product_code, status, note FROM product_launch_overrides WHERE removed_at IS NULL ORDER BY product_code, id DESC`);
    r.rows.forEach((x) => overrides.set(x.product_code, { status: x.status, note: x.note }));
  } catch (e) { /* none */ }
  return { drops, overrides };
}

module.exports = { loadLaunchContext };
