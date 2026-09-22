import assert from "node:assert/strict";
import { test } from "node:test";
import { clearHoursCache, describe, entriesBetween, hoursTool, parseCalendar } from "../src/tools/hours.js";
import { stubFetch } from "./helpers.js";

// A small calendar shaped like the athletics department's: weekly rules written as the hours,
// an override for one day, a skipped day, an all-day closure, and a rule that ended long ago.
const ics = [
  "BEGIN:VCALENDAR",
  "BEGIN:VEVENT", "UID:weekday", "DTSTART;TZID=America/New_York:20260914T060000", "DTEND;TZID=America/New_York:20260914T220000",
  "RRULE:FREQ=WEEKLY;WKST=SU;UNTIL=20261212T045959Z;BYDAY=MO,TU,WE,TH", "EXDATE;TZID=America/New_York:20260923T060000", "SUMMARY:6am-10pm", "END:VEVENT",
  "BEGIN:VEVENT", "UID:weekday", "RECURRENCE-ID;TZID=America/New_York:20260924T060000", "DTSTART;TZID=America/New_York:20260924T060000",
  "DTEND;TZID=America/New_York:20260924T170000", "SUMMARY:6am-5pm", "END:VEVENT",
  "BEGIN:VEVENT", "UID:twin", "DTSTART;TZID=America/New_York:20220912T060000", "DTEND;TZID=America/New_York:20220912T220000",
  "RRULE:FREQ=WEEKLY;BYDAY=MO", "SUMMARY:6am-10pm", "END:VEVENT",
  "BEGIN:VEVENT", "UID:break", "DTSTART;VALUE=DATE:20260925", "DTEND;VALUE=DATE:20260927", "SUMMARY:CLOSED", "END:VEVENT",
  "BEGIN:VEVENT", "UID:old", "DTSTART;TZID=America/New_York:20150105T060000", "RRULE:FREQ=WEEKLY;UNTIL=20150301T000000Z;BYDAY=MO,TU", "SUMMARY:6am-noon", "END:VEVENT",
  "BEGIN:VEVENT", "UID:wall", "DTSTART;TZID=America/New_York:20260927T160000", "DTEND;TZID=America/New_York:20260927T193000", "SUMMARY:Open Hours", "END:VEVENT",
  "END:VCALENDAR",
].join("\r\n");

const week = (cal) => Object.fromEntries([...entriesBetween(cal, "2026-09-21", "2026-09-27")].map(([d, es]) => [d, es.map(describe)]));

test("weekly rules, overrides, skipped days and all-day closures land on the right days", () => {
  assert.deepEqual(week(parseCalendar(ics)), {
    "2026-09-21": ["6am-10pm"], // two rules say the same thing: said once
    "2026-09-22": ["6am-10pm"],
    "2026-09-23": [], // EXDATE: nothing posted, not "closed"
    "2026-09-24": ["6am-5pm"], // the override replaces the rule's day
    "2026-09-25": ["CLOSED"],
    "2026-09-26": ["CLOSED"], // all-day entries run up to their end date
    "2026-09-27": ["4pm-7:30pm (Open Hours)"], // a title without hours gets the entry's own times
  });
});

test("entries that ended before the cutoff are skipped without changing the answer", () => {
  const all = parseCalendar(ics);
  const recent = parseCalendar(ics, "20260914");
  assert.ok(recent.masters.length < all.masters.length);
  assert.deepEqual(week(recent), week(all));
});

const libcal = {
  locations: [
    {
      lid: 4403,
      name: "Davis Family Library",
      weeks: [
        {
          Tuesday: { date: "2026-09-22", times: { status: "open", hours: [{ from: "7:30am", to: "12am" }] } },
          Saturday: { date: "2026-09-26", times: { status: "closed" } },
          Sunday: { date: "2026-09-27", times: { status: "not-set" } },
        },
      ],
    },
  ],
};

test("library hours come from LibCal, and an unset day is 'nothing posted', not closed", async (t) => {
  clearHoursCache();
  const requested = stubFetch(t, { "libcal.com": { body: libcal } });
  const out = await hoursTool.run({ place: "library", date: "2026-09-22", days: 7 }, {}, new Date("2026-09-22T16:00:00Z"));
  const days = JSON.parse(out.content).days.map((d) => d.hours);
  assert.deepEqual(days[0], ["7:30am-12am"]);
  assert.deepEqual(days[4], ["Closed"]);
  assert.equal(days[5], "nothing posted");
  assert.equal(out.card.type, "hours");
  assert.ok(requested.inits[0].headers["user-agent"], "sends a User-Agent");
});

test("the gym's hours come from the athletics calendar", async (t) => {
  clearHoursCache();
  stubFetch(t, { "calendar.google.com": { body: ics } });
  const out = await hoursTool.run({ place: "fitness-center", date: "2026-09-24" }, {}, new Date("2026-09-22T16:00:00Z"));
  assert.deepEqual(JSON.parse(out.content).days[0].hours, ["6am-5pm"]);
});

test("unknown places and past dates are errors the model can read", async () => {
  await assert.rejects(hoursTool.run({ place: "climbing-wall" }), /place must be one of/);
  await assert.rejects(hoursTool.run({ place: "library", date: "2026-01-01" }, {}, new Date("2026-09-22T16:00:00Z")), /current and upcoming/);
});
