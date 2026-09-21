// Everything on campus runs on Vermont time, whatever time zone the server is in.
const ZONE = "America/New_York";

function parts(date) {
  const fmt = new Intl.DateTimeFormat("en-US", {
    timeZone: ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  return Object.fromEntries(fmt.formatToParts(date).map((p) => [p.type, p.value]));
}

// "2026-09-21"
export function campusDate(date = new Date()) {
  const p = parts(date);
  return `${p.year}-${p.month}-${p.day}`;
}

// 0-23
export function campusHour(date = new Date()) {
  return Number(parts(date).hour);
}

// "2026-09-21" -> "2026-09-22"
export function addDays(isoDate, days) {
  const d = new Date(`${isoDate}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// "Monday, September 21, 2026 at 6:42 PM"
export function campusNowLabel(date = new Date()) {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: ZONE,
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}
