// Free study rooms in Davis Family Library, from LibCal's room booking (the same LibCal that
// supplies library hours). The booking page lists the rooms; its availability grid gives each
// room's 15-minute slots, in Vermont time, with a class for booked ones. LibCal's robots.txt
// asks for 10 seconds between requests, so the room list is cached a day and each day's
// availability 10 minutes. Booking needs the student's own login, so this only shows what's
// free and links to the booking page.
import { addDays, campusDate, campusTime } from "../campus-time.js";
import { ToolInputError } from "./errors.js";
import { USER_AGENT } from "../user-agent.js";

const BASE = "https://middlebury.libcal.com";
const LOCATION = 7141; // Davis Family Library
export const BOOKING = `${BASE}/reserve`;
const ROOMS_MS = 24 * 60 * 60 * 1000;
const SLOTS_MS = 10 * 60 * 1000;
export const SOURCE_LABEL = "Davis Family Library room booking (LibCal)";

let roomsCache = null;
const slotsCache = new Map();
export function clearStudyRoomsCache() {
  roomsCache = null;
  slotsCache.clear();
}

const unescape = (s) => s.replace(/\\u([0-9a-f]{4})/gi, (_, h) => String.fromCharCode(parseInt(h, 16))).replace(/\\(.)/g, "$1");

// The booking page builds its room list in script: resources.push({ id: "eid_48662",
// title: "LIB 150A (Capacity 4)", eid: 48662, grouping: "Group Study Room (Davis)", capacity: 4, ... })
export function parseRooms(html) {
  const rooms = [];
  for (const [, body] of html.matchAll(/resources\.push\(\{([\s\S]*?)\}\);/g)) {
    const field = (name) => body.match(new RegExp(`\\b${name}:\\s*("(?:[^"\\\\]|\\\\.)*"|\\d+)`))?.[1];
    const eid = Number(field("eid"));
    const title = field("title");
    if (!eid || !title) continue;
    rooms.push({
      id: eid,
      name: unescape(title.slice(1, -1)).replace(/\s*\(Capacity \d+\)\s*$/i, ""),
      kind: unescape((field("grouping") ?? '""').slice(1, -1)),
      capacity: Number(field("capacity")) || null,
    });
  }
  return rooms;
}

// A free slot has no class; "s-lc-eq-checkout" is booked and "s-lc-eq-r-padding" the buffer
// after a booking. Consecutive free slots join into windows.
export function freeWindows(slots, roomId, after = "00:00") {
  const free = slots
    .filter((s) => s.itemId === roomId && !s.className && s.start.slice(11, 16) >= after)
    .sort((a, b) => a.start.localeCompare(b.start));
  const windows = [];
  for (const s of free) {
    const last = windows.at(-1);
    if (last && last.end === s.start) last.end = s.end;
    else windows.push({ start: s.start, end: s.end });
  }
  return windows.map((w) => ({ from: w.start.slice(11, 16), to: w.end.slice(11, 16) === "00:00" ? "24:00" : w.end.slice(11, 16) }));
}

async function get(url, init, fetchImpl) {
  const res = await fetchImpl(url, { ...init, headers: { "user-agent": USER_AGENT, ...init?.headers }, signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error(`LibCal returned ${res.status}`);
  return res;
}

async function loadRooms(fetchImpl) {
  if (roomsCache && Date.now() - roomsCache.at < ROOMS_MS) return roomsCache.rooms;
  const rooms = parseRooms(await (await get(`${BOOKING}?lid=${LOCATION}`, {}, fetchImpl)).text());
  if (!rooms.length) throw new Error("LibCal's booking page listed no rooms");
  roomsCache = { at: Date.now(), rooms };
  return rooms;
}

async function loadSlots(date, fetchImpl) {
  const hit = slotsCache.get(date);
  if (hit && Date.now() - hit.at < SLOTS_MS) return hit;
  const body = new URLSearchParams({ lid: LOCATION, gid: 0, eid: -1, seat: 0, seatId: 0, zone: 0, start: date, end: addDays(date, 1), pageIndex: 0, pageSize: 50 });
  const res = await get(`${BASE}/spaces/availability/grid`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", "x-requested-with": "XMLHttpRequest", referer: BOOKING, accept: "application/json" },
    body,
  }, fetchImpl);
  const entry = { at: Date.now(), slots: (await res.json()).slots ?? [] };
  slotsCache.set(date, entry);
  return entry;
}

export async function getStudyRooms({ date, after, people, kind = "study", now = new Date() } = {}, fetchImpl = fetch) {
  const today = campusDate(now);
  const day = date ?? today;
  const from = after ?? (day === today ? campusTime(now) : "00:00");
  const [rooms, { at, slots }] = await Promise.all([loadRooms(fetchImpl), loadSlots(day, fetchImpl)]);
  const wanted = rooms.filter((r) => (kind === "video" ? /video/i.test(r.kind) : !/video/i.test(r.kind)) && (!people || !r.capacity || r.capacity >= people));
  const withTimes = wanted.map((r) => ({ ...r, free: freeWindows(slots, r.id, from) }));
  const largest = Math.max(0, ...rooms.filter((r) => (kind === "video") === /video/i.test(r.kind)).map((r) => r.capacity ?? 0));
  return {
    ...(people && !wanted.length && { tooBig: `No ${kind === "video" ? "video" : "study"} room holds ${people}; the largest holds ${largest}.` }),
    checkedAt: new Date(at).toISOString(),
    date: day,
    after: from,
    anyPosted: slots.length > 0,
    rooms: withTimes.sort((a, b) => b.free.length - a.free.length || a.name.localeCompare(b.name)),
  };
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

export const studyRoomsTool = {
  definition: {
    name: "get_study_rooms",
    description:
      "Which Davis Family Library group study rooms (or video viewing rooms) are free on a day, from the library's LibCal room booking, as free time windows per room with its capacity. " +
      "Booking needs the student's Middlebury login on LibCal; the card links there. Rooms can be booked by someone else at any moment, so say it's what was free when checked. " +
      "A day with nothing posted may be beyond the booking window or a closed day; say nothing is posted, not that the library is closed.",
    input_schema: {
      type: "object",
      properties: {
        date: { type: "string", description: "YYYY-MM-DD, Vermont time. Omit for today." },
        after: { type: "string", description: "HH:MM (24-hour). Omit for now when the date is today." },
        people: { type: "integer", description: "How many people, to skip rooms that are too small." },
        kind: { type: "string", enum: ["study", "video"], description: "Default study (group study rooms)." },
      },
      additionalProperties: false,
    },
  },
  async run(input) {
    if (input.date !== undefined && !DATE.test(input.date)) throw new ToolInputError("date must be YYYY-MM-DD");
    if (input.after !== undefined && !TIME.test(input.after)) throw new ToolInputError("after must be HH:MM (24-hour)");
    const r = await getStudyRooms({ date: input.date, after: input.after, people: Number(input.people) || undefined, kind: input.kind === "video" ? "video" : "study" });
    const clock = (t) => {
      const [h, m] = t.split(":").map(Number);
      if (h === 24) return "midnight";
      return `${h % 12 || 12}:${String(m).padStart(2, "0")}${h < 12 ? "am" : "pm"}`;
    };
    const rooms = r.rooms.map((room) => ({ ...room, free: room.free.map((w) => `${clock(w.from)}-${clock(w.to)}`) }));
    return {
      content: JSON.stringify({
        source: SOURCE_LABEL,
        note: "Free when checked; rooms can be booked at any moment. Booking needs a Middlebury login.",
        date: r.date,
        from: clock(r.after),
        ...(!r.anyPosted && { nothing_posted: "LibCal has no slots for this day." }),
        ...(r.tooBig && { too_big: r.tooBig }),
        rooms: rooms.map(({ name, capacity, free }) => ({ room: name, capacity, free: free.length ? free : "nothing free" })),
      }),
      card: { type: "studyrooms", date: r.date, from: clock(r.after), rooms, source: { label: SOURCE_LABEL, url: BOOKING, checkedAt: r.checkedAt } },
    };
  },
};
