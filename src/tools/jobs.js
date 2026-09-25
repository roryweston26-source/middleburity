// Open jobs on Middlebury's own job board (apply.workable.com/middleburycollege), which Student
// Employment points students to. Workable's robots.txt says "ai-input=yes, ai-train=no", and
// the board's list comes from its public jobs API. The list pages 10 at a time, so the whole
// board is read at most every 6 hours and searched here.
import { ToolInputError } from "./errors.js";
import { USER_AGENT } from "../user-agent.js";

const ACCOUNT = "middleburycollege";
const API = `https://apply.workable.com/api/v3/accounts/${ACCOUNT}/jobs`;
export const BOARD = `https://apply.workable.com/${ACCOUNT}/`;
const CACHE_MS = 6 * 60 * 60 * 1000;
const MAX_PAGES = 30; // 300 jobs; the board had 143 on 2026-09-24
export const SOURCE_LABEL = "Middlebury's job board (Workable)";

let cache = null;
export function clearJobsCache() {
  cache = null;
}

export function normalizeJob(raw) {
  return {
    title: (raw.title ?? "").trim(),
    // Workable's own tag. Not every student job carries it: on 2026-09-24 the only lifeguard
    // posting was tagged Staff.
    department: (raw.department ?? []).join(", ") || null,
    type: { full: "full-time", part: "part-time", contract: "contract", temporary: "temporary" }[raw.type] ?? null,
    posted: raw.published ? raw.published.slice(0, 10) : null,
    url: `${BOARD}j/${raw.shortcode}/`,
  };
}

async function loadBoard(fetchImpl = fetch) {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache;
  const jobs = [];
  let token;
  for (let page = 0; page < MAX_PAGES; page++) {
    const res = await fetchImpl(API, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json", "user-agent": USER_AGENT },
      body: JSON.stringify({ query: "", location: [], department: [], worktype: [], remote: [], ...(token && { token }) }),
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) throw new Error(`job board returned ${res.status}`);
    const json = await res.json();
    jobs.push(...(json.results ?? []).filter((r) => r.state === "published" && !r.isInternal).map(normalizeJob));
    token = json.nextPage;
    if (!token || !json.results?.length) break;
  }
  cache = { at: Date.now(), jobs };
  return cache;
}

// Whole words, like club search: "art" shouldn't match "Department".
const wordRe = (w) => new RegExp(`\\b${w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`, "i");

export function searchJobs(jobs, { keyword, students = true, limit = 10 }) {
  const words = (keyword ?? "").toLowerCase().split(/\s+/).filter(Boolean).map(wordRe);
  const hits = jobs.filter((j) => (!students || j.department === "Student") && words.every((re) => re.test(j.title)));
  hits.sort((a, b) => (b.posted ?? "").localeCompare(a.posted ?? ""));
  return { total: hits.length, jobs: hits.slice(0, limit) };
}

export async function getJobs({ keyword, students = true, limit = 10 } = {}, fetchImpl) {
  const { at, jobs } = await loadBoard(fetchImpl);
  let found = searchJobs(jobs, { keyword, students, limit });
  // A keyword that only matches jobs without the Student tag still comes back, marked.
  let widened = false;
  if (keyword && students && !found.total) {
    found = searchJobs(jobs, { keyword, students: false, limit });
    widened = found.total > 0;
  }
  return { checkedAt: new Date(at).toISOString(), onBoard: jobs.length, widened, ...found };
}

export const jobsTool = {
  definition: {
    name: "get_jobs",
    description:
      "Open jobs on Middlebury's job board (Workable), where Student Employment says campus jobs are posted: title, Workable's department tag (Student or Staff), part- or full-time, posting date, and a link to apply. " +
      "Student-tagged jobs by default; set all_jobs for staff jobs too. Search by words in the title (\"lifeguard\", \"dining\", \"tutor\"). " +
      "Pay and hours aren't in the list; for pay, search_pages has the student wage scale. Only say a job is open if it's in the result.",
    input_schema: {
      type: "object",
      properties: {
        keyword: { type: "string", description: 'Words from the job title, e.g. "lifeguard", "library". Omit for the newest student jobs.' },
        all_jobs: { type: "boolean", description: "Include staff jobs. Default false." },
        limit: { type: "integer", description: "How many jobs, 1-15. Default 10." },
      },
      additionalProperties: false,
    },
  },
  async run(input) {
    if (input.keyword !== undefined && typeof input.keyword !== "string") throw new ToolInputError("keyword must be a string");
    const limit = Math.min(Math.max(Number(input.limit) || 10, 1), 15);
    const r = await getJobs({ keyword: input.keyword?.trim() || undefined, students: input.all_jobs !== true, limit });
    return {
      content: JSON.stringify({
        source: SOURCE_LABEL,
        note: "Department tags are Workable's; some student jobs are tagged Staff. Only these jobs are known to be open.",
        jobs_on_board: r.onBoard,
        matching: r.total,
        ...(r.widened && { widened: "No Student-tagged job matched, so these include Staff-tagged jobs." }),
        jobs: r.jobs.map(({ title, department, type, posted, url }) => ({ title, department, type, posted, apply: url })),
      }),
      card: { type: "jobs", jobs: r.jobs, total: r.total, source: { label: SOURCE_LABEL, url: BOARD, checkedAt: r.checkedAt } },
    };
  },
};
