import assert from "node:assert/strict";
import { test } from "node:test";
import { clearStudyRoomsCache, freeWindows, getStudyRooms, parseRooms } from "../src/tools/studyrooms.js";

// The shape LibCal's booking page uses, escapes included.
const PAGE = `<script>
resources.push({
  id: "eid_48662", title: "LIB\\u0020150A (Capacity 4)", url: "/space/48662", eid: 48662, gid: 12630, lid: 7141,
  grouping: "Group\\u0020Study\\u0020Room\\u0020\\u0028Davis\\u0029", gtype: 2, capacity: 4, filterIds: [3262],
});
resources.push({
  id: "eid_50001", title: "Video Viewing Room", url: "/space/50001", eid: 50001, gid: 12631, lid: 7141,
  grouping: "Video\\u0020Viewing\\u0020Room", gtype: 2, capacity: 8,
});
</script>`;

const slot = (itemId, start, end, className) => ({ itemId, start: `2026-09-25 ${start}:00`, end: `2026-09-25 ${end}:00`, ...(className && { className }) });
const SLOTS = [
  slot(48662, "19:00", "19:15"),
  slot(48662, "19:15", "19:30"),
  slot(48662, "19:30", "19:45", "s-lc-eq-checkout"),
  slot(48662, "19:45", "20:00", "s-lc-eq-r-padding"),
  slot(48662, "20:00", "20:15"),
  slot(48662, "23:45", "00:00"),
];

test("rooms come from the booking page's script, names unescaped", () => {
  assert.deepEqual(parseRooms(PAGE), [
    { id: 48662, name: "LIB 150A", kind: "Group Study Room (Davis)", capacity: 4 },
    { id: 50001, name: "Video Viewing Room", kind: "Video Viewing Room", capacity: 8 },
  ]);
});

test("free slots join into windows; booked and buffer slots break them", () => {
  assert.deepEqual(freeWindows(SLOTS, 48662), [
    { from: "19:00", to: "19:30" },
    { from: "20:00", to: "20:15" },
    { from: "23:45", to: "24:00" },
  ]);
  assert.deepEqual(freeWindows(SLOTS, 48662, "20:00"), [{ from: "20:00", to: "20:15" }, { from: "23:45", to: "24:00" }]);
});

function fakeLibCal() {
  const requests = [];
  const fetchImpl = async (url, init = {}) => {
    requests.push({ url: String(url), method: init.method ?? "GET" });
    if (String(url).includes("/reserve")) return new Response(PAGE);
    return new Response(JSON.stringify({ slots: SLOTS }));
  };
  return { requests, fetchImpl };
}

test("study rooms by default, video rooms on request, too-small rooms skipped", async () => {
  clearStudyRoomsCache();
  const lib = fakeLibCal();
  const study = await getStudyRooms({ date: "2026-09-25", after: "00:00" }, lib.fetchImpl);
  assert.deepEqual(study.rooms.map((r) => r.name), ["LIB 150A"]);
  assert.equal((await getStudyRooms({ date: "2026-09-25", kind: "video" }, lib.fetchImpl)).rooms[0].name, "Video Viewing Room");
  const big = await getStudyRooms({ date: "2026-09-25", people: 6 }, lib.fetchImpl);
  assert.equal(big.tooBig, "No study room holds 6; the largest holds 4.");
  // The room list and the day's slots were each fetched once and then cached.
  assert.equal(lib.requests.length, 2);
  assert.equal(lib.requests[1].method, "POST");
});
