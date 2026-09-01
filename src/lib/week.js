// Monday-Sunday ISO weeks, used by the Weekly Creative Dashboard.

function isoWeekNumber(date) {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return Math.ceil(((d - yearStart) / 86400000 + 1) / 7);
}

function startOfDay(date) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d;
}

// weekOffset: 0 = the week containing "now", -1 = last week, 1 = next week.
function getWeekRange(weekOffset = 0, now = new Date()) {
  const today = startOfDay(now);
  const day = today.getDay(); // 0 = Sun .. 6 = Sat
  const diffToMonday = day === 0 ? -6 : 1 - day;

  const start = new Date(today);
  start.setDate(today.getDate() + diffToMonday + weekOffset * 7);

  const end = new Date(start);
  end.setDate(start.getDate() + 6);
  end.setHours(23, 59, 59, 999);

  const daysRemaining =
    weekOffset < 0 ? 0 : weekOffset > 0 ? 7 : Math.max(0, Math.round((startOfDay(end) - today) / 86400000) + 1);
  const daysElapsed = 7 - daysRemaining;

  return {
    weekNumber: isoWeekNumber(start),
    start,
    end,
    daysRemaining,
    daysElapsed,
  };
}

function formatWeekLabel({ start, end }) {
  const fmt = (d) => d.toLocaleDateString('en-AU', { day: 'numeric', month: 'short' });
  return `${fmt(start)} – ${fmt(end)}, ${end.getFullYear()}`;
}

module.exports = { getWeekRange, formatWeekLabel, isoWeekNumber };
