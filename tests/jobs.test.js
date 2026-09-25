import assert from "node:assert/strict";
import { test } from "node:test";
import { clearJobsCache, getJobs, normalizeJob, searchJobs } from "../src/tools/jobs.js";

const raw = (title, department, extra = {}) => ({ title, department: [department], type: "part", shortcode: title.slice(0, 4), state: "published", isInternal: false, published: "2026-09-20T00:00:00.000Z", ...extra });

// Two pages, the way Workable pages its list.
function fakeBoard() {
  const pages = [
    { total: 4, results: [raw("Ross Dining Waitstaff (AY 26-27)", "Student"), raw("Residence Director", "Staff")], nextPage: "p2" },
    { total: 4, results: [raw("Athletics Lifeguard (Summer 2026)", "Staff"), raw("Art Museum Receptionist", "Student", { published: "2026-09-22T00:00:00.000Z" }), raw("Hidden", "Student", { isInternal: true })] },
  ];
  const requests = [];
  const fetchImpl = async (url, init) => {
    requests.push(JSON.parse(init.body));
    return new Response(JSON.stringify(pages[requests.length - 1]));
  };
  return { requests, fetchImpl };
}

test("jobs keep Workable's tag, type, date and apply link", () => {
  const j = normalizeJob(raw("Ross Dining Waitstaff", "Student"));
  assert.deepEqual(j, { title: "Ross Dining Waitstaff", department: "Student", type: "part-time", posted: "2026-09-20", url: "https://apply.workable.com/middleburycollege/j/Ross/" });
});

test("the whole board is read page by page, then cached", async () => {
  clearJobsCache();
  const board = fakeBoard();
  const r = await getJobs({}, board.fetchImpl);
  assert.equal(board.requests.length, 2);
  assert.equal(board.requests[1].token, "p2");
  assert.equal(r.onBoard, 4); // the internal posting is dropped
  assert.deepEqual(r.jobs.map((j) => j.title), ["Art Museum Receptionist", "Ross Dining Waitstaff (AY 26-27)"]); // newest first, students only
  await getJobs({ keyword: "dining" }, board.fetchImpl);
  assert.equal(board.requests.length, 2);
});

test("a keyword that only matches staff-tagged jobs still comes back, marked", async () => {
  clearJobsCache();
  const r = await getJobs({ keyword: "lifeguard" }, fakeBoard().fetchImpl);
  assert.equal(r.widened, true);
  assert.equal(r.jobs[0].title, "Athletics Lifeguard (Summer 2026)");
});

test("keywords match whole words in the title", () => {
  const jobs = [normalizeJob(raw("Art Museum Receptionist", "Student")), normalizeJob(raw("Department Assistant", "Student"))];
  assert.deepEqual(searchJobs(jobs, { keyword: "art" }).jobs.map((j) => j.title), ["Art Museum Receptionist"]);
});
