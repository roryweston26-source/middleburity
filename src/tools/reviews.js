// A link to a Middlebury professor's reviews on RateMyProfessors, shown as a card. Rory's call
// (2026-09-24): link it for a specific professor or course, never for rankings like "easiest
// grader". Middleburity never reads RMP: its robots.txt disallows every bot but Google's and
// names AI crawlers outright, so the student opens the link in their own browser. The name is
// checked against Middlebury's faculty profiles first, so the card only ever links real faculty.
import { ToolInputError } from "./errors.js";

const RMP_SCHOOL = 605; // Middlebury College on RateMyProfessors (ratemyprofessors.com/school/605)
const rmpSearch = (name) => `https://www.ratemyprofessors.com/search/professors/${RMP_SCHOOL}?q=${encodeURIComponent(name)}`;

// Profile titles are names, sometimes with a note ("Kate (Professor) Crawford"). Student
// profiles in the same section carry a class year ("Gar Olson, '22") and are skipped.
const words = (s) => s.toLowerCase().replace(/\(.*?\)/g, " ").normalize("NFD").replace(/[̀-ͯ]/g, "").match(/[a-z]+/g) ?? [];
const isStudent = (title) => /[’'‘]\d{2}/.test(title);

export async function findFaculty(db, name) {
  const wanted = words(name).filter((w) => w.length > 1 && !["professor", "prof", "dr"].includes(w));
  if (!wanted.length) return [];
  const last = wanted.at(-1);
  const { results } = await db
    .prepare("SELECT title, url FROM pages WHERE section = 'college/people' AND lower(title) LIKE ?")
    .bind(`%${last}%`)
    .all();
  const matches = results.filter((r) => !isStudent(r.title) && wanted.every((w) => words(r.title).includes(w)));
  // An exact name beats longer ones that contain it ("Alex Lyford" over "Alex Lyford Jr").
  const exact = matches.filter((r) => words(r.title).join(" ") === wanted.join(" "));
  return exact.length ? exact : matches;
}

export const reviewsTool = {
  displayOnly: true,
  definition: {
    name: "get_reviews_link",
    description:
      "A link card to a Middlebury professor's student reviews on RateMyProfessors, for when the student asks about a specific professor, or about the professors of a specific course you found through search_pages. " +
      "Answer first from Middlebury's pages (the professor's profile: courses taught, office hours). " +
      "You can't read the reviews: never describe, summarize or guess what they say, and don't use this for questions that rank or compare professors (easiest grader, best teacher). " +
      "At most three per answer.",
    input_schema: {
      type: "object",
      properties: {
        professor: { type: "string", description: 'Their full name as on their Middlebury profile, e.g. "Emma Guiberson".' },
      },
      required: ["professor"],
      additionalProperties: false,
    },
  },
  async run(input, env = {}) {
    const name = typeof input.professor === "string" ? input.professor.trim() : "";
    if (!name) throw new ToolInputError("professor must be a name");
    if (!env.DB) throw new ToolInputError("the faculty directory isn't available");
    const found = await findFaculty(env.DB, name);
    if (found.length !== 1) {
      throw new ToolInputError(
        found.length ? `several faculty profiles match "${name}": ${found.map((f) => f.title).join(", ")}; use the full name` : `no Middlebury faculty profile matches "${name}"; find their profile with search_pages first`,
      );
    }
    const [prof] = found;
    const displayName = prof.title.replace(/\s*\(.*?\)\s*/g, " ").trim();
    const url = rmpSearch(displayName);
    return {
      content: JSON.stringify({ professor: displayName, link: "shown to the student as a card", note: "You can't see these reviews. Don't describe them." }),
      card: { type: "reviews", professor: displayName, url, profile: prof.url },
    };
  },
};
