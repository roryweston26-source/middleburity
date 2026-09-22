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
  const title = decode(main.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i)?.[1]?.replace(/<[^>]+>/g, "") ?? "").replace(/\s+/g, " ").trim();
  main = main.replace(/<h([1-4])[^>]*>([\s\S]*?)<\/h\1>/gi, (_, level, inner) => `\n§${level} ${inner.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim()}\n`);
  main = main.replace(/<(br|\/p|\/li|\/div|\/tr|\/h\d)\b[^>]*>/gi, "\n").replace(/<li\b[^>]*>/gi, "\n- ");
  const text = scrub(decode(main.replace(/<[^>]+>/g, " ")));
  const sections = [];
  let current = { heading: title, lines: [] };
  for (const raw of text.split("\n")) {
    const line = raw.replace(/\s+/g, " ").trim();
    if (!line || line === "-") continue; // blank lines and empty list bullets
    const h = line.match(/^(?:- )?§([1-4]) (.*)$/);
    if (h) {
      if (h[1] === "1") continue;
      if (current.lines.length) sections.push(current);
      current = { heading: h[2].trim(), lines: [] };
    } else {
      current.lines.push(line);
    }
  }
  if (current.lines.length) sections.push(current);
  return { title, sections };
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

