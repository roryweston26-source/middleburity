// Turns a middlebury.edu page into titled passages for page search.
// Used by scripts/build-pages.js; kept separate so tests can check it without crawling.
const ENTITIES = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", ndash: "–", mdash: "—", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“", hellip: "…" };
export const decode = (s) =>
  s.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (m, e) => {
    if (e[0] === "#") return String.fromCodePoint(e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : +e.slice(1));
    return ENTITIES[e.toLowerCase()] ?? m;
  });

// Contact details stay on the linked page; the index doesn't need them.
export const scrub = (s) =>
  s
    .replace(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g, "")
    .replace(/(\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}/g, "");

// The page's own content: <main>, minus navigation, forms and scripts. Headings are kept
// as section breaks so each passage knows which part of the page it came from.
export function extract(html) {
  const start = html.indexOf("<main");
  const end = html.indexOf("</main>");
  if (start < 0 || end < 0) return null;
  let main = html.slice(start, end);
  main = main.replace(/<(script|style|nav|form|svg|button|noscript|select)\b[\s\S]*?<\/\1>/gi, " ");
  const headingText = (re) => decode(main.match(re)?.[1]?.replace(/<[^>]+>/g, " ") ?? "").replace(/\s+/g, " ").trim();
  // Most pages title themselves with <h1>; the Handbook starts at <h2>, so fall back to the first heading.
  const title = headingText(/<h1[^>]*>([\s\S]*?)<\/h1>/i) || headingText(/<h[2-4][^>]*>([\s\S]*?)<\/h[2-4]>/i);
  main = main.replace(/<h([1-4])[^>]*>([\s\S]*?)<\/h\1>/gi, (_, level, inner) => `\n§${level} ${inner.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim()}\n`);
  main = main.replace(/<(br|\/p|\/li|\/div|\/tr|\/h\d)\b[^>]*>/gi, "\n").replace(/<li\b[^>]*>/gi, "\n- ");
  const text = scrub(decode(main.replace(/<[^>]+>/g, " ")));
  const sections = [];
  let current = { heading: title, lines: [] };
  // A heading with nothing under it before the next one ("Meal Plans", then "Unlimited Plan")
  // is a parent: it's kept as a prefix, so "Meal Plans › Unlimited Plan" still says "meal plan".
  let parent = null;
  for (const raw of text.split("\n")) {
    const line = raw.replace(/\s+/g, " ").trim();
    if (!line || line === "-") continue; // blank lines and empty list bullets
    const h = line.match(/^(?:- )?§([1-4]) (.*)$/);
    if (h) {
      if (h[1] === "1") continue;
      const level = Number(h[1]);
      if (current.lines.length) {
        sections.push(current);
        if (parent && level <= parent.level) parent = null;
      } else if (current.level && current.level < level) {
        parent = { heading: current.heading, level: current.level };
      }
      const text = h[2].trim();
      current = { heading: parent && level > parent.level ? `${parent.heading} › ${text}` : text, level, lines: [] };
    } else {
      current.lines.push(line);
    }
  }
  if (current.lines.length) sections.push(current);
  return { title, sections };
}

// Removes boilerplate: a passage repeated word for word on several office pages (a "Make an
// Appointment" box on every health page, say) is kept only on the page with the shortest
// address, usually the section's front page. Faculty profiles keep their copies, because a
// course description repeated on each teacher's profile says who teaches it.
export function dedupePassages(index) {
  const isProfile = (p) => index.pages[p].section === "college/people";
  const firstHome = new Map(); // passage text -> page that keeps it
  for (const c of index.chunks) {
    if (isProfile(c.p)) continue;
    const key = c.t.trim().toLowerCase();
    const kept = firstHome.get(key);
    if (kept === undefined || index.pages[c.p].url.length < index.pages[kept].url.length) firstHome.set(key, c.p);
  }
  let chunks = index.chunks.filter((c) => isProfile(c.p) || firstHome.get(c.t.trim().toLowerCase()) === c.p);

  // Near-copies: the same block with small edits, like the "Resources and Support" list at
  // the end of every drugs-and-alcohol page. Same section, same first 20 words, on 3+ pages.
  const opening = (c) => `${index.pages[c.p].section}|${c.t.toLowerCase().split(/\s+/).slice(0, 20).join(" ")}`;
  const pagesWith = new Map();
  for (const c of chunks) {
    if (isProfile(c.p) || c.t.split(/\s+/).length < 20) continue;
    const key = opening(c);
    if (!pagesWith.has(key)) pagesWith.set(key, new Set());
    pagesWith.get(key).add(c.p);
  }
  const keeper = new Map();
  for (const [key, set] of pagesWith) {
    if (set.size >= 3) keeper.set(key, [...set].sort((a, b) => index.pages[a].url.length - index.pages[b].url.length)[0]);
  }
  chunks = chunks.filter((c) => {
    if (isProfile(c.p) || c.t.split(/\s+/).length < 20) return true;
    const kept = keeper.get(opening(c));
    return kept === undefined || kept === c.p;
  });
  return { ...index, chunks, removed: index.chunks.length - chunks.length };
}

// Passages of at most ~220 words. Very short sections merge into the next one, and a
// merged section keeps its own heading inline ("Atwater Dining Hall: Lunch 11-2 ...") so
// no passage ends up describing one thing under another thing's heading.
export function chunk(sections, maxWords = 220) {
  const chunks = [];
  let carry = null;
  for (const s of sections) {
    let words = s.lines.join(" ").split(" ").filter(Boolean);
    if (carry) {
      words = [...carry.words, `${s.heading}:`, ...words];
      carry = null;
    }
    if (words.length < 25) {
      carry = { words: [`${s.heading}:`, ...words] };
      continue;
    }
    for (let i = 0; i < words.length; i += maxWords) {
      chunks.push({ heading: s.heading, text: words.slice(i, i + maxWords).join(" ") });
    }
  }
  if (carry && carry.words.length) chunks.push({ heading: sections.at(-1)?.heading ?? "", text: carry.words.join(" ") });
  return chunks;
}

