// Everything the page does. Answers and source data are built as DOM nodes (never
// innerHTML), so nothing a source or the model returns can inject markup.
const MAX_HISTORY = 12;
const history = []; // plain text turns, kept in memory only, gone on reload

const $ = (sel) => document.querySelector(sel);

function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === false) continue;
    if (key === "class") node.className = value;
    else if (key === "text") node.textContent = value;
    // Links come from source feeds; only web addresses become links (never javascript: and the like).
    else if (key === "href" && !/^https?:\/\//i.test(value)) continue;
    else node.setAttribute(key, value === true ? "" : value);
  }
  for (const child of children.flat(Infinity)) {
    if (child != null) node.append(child);
  }
  return node;
}

const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1).replace("-", " ");

function shortDate(iso) {
  return new Date(`${iso}T12:00:00`).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
}

function checkedTime(iso) {
  return new Date(iso).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: "America/New_York" });
}

// ---------- Menu card ----------

const VEG_TAGS = new Set(["Vegan", "Vegetarian"]);

function itemRow(item) {
  return el(
    "li",
    {},
    item.name,
    (item.tags ?? []).map((t) => el("span", { class: VEG_TAGS.has(t) ? "tag veg" : "tag", text: t })),
  );
}

function hallBlock(menu) {
  if (!menu.stations) {
    return el("div", { class: "status" }, el("strong", { text: `${menu.hallName}: ` }), menu.status);
  }
  const preview = menu.stations[0].items.slice(0, 3).map((i) => i.name).join(" · ");
  return el(
    "details",
    { class: "hall" },
    el(
      "summary",
      {},
      el("span", { class: "hall-name", text: menu.hallName }),
      el("span", { class: "chevron", "aria-hidden": "true", text: "›" }),
      el("span", { class: "hall-preview", text: preview }),
    ),
    el(
      "div",
      { class: "stations" },
      menu.stations.map((s) =>
        el("div", {}, el("p", { class: "station-name", text: s.name }), el("ul", { class: "items" }, s.items.map(itemRow))),
      ),
    ),
  );
}

function menuCard(card, label) {
  const meals = [...new Set(card.menus.map((m) => m.meal))];
  const title = label ?? (meals.length === 1 ? cap(meals[0]) : "Dining halls");
  const body = meals.map((meal) => [
    meals.length > 1 ? el("p", { class: "meal-label", text: cap(meal) }) : null,
    card.menus.filter((m) => m.meal === meal).map(hallBlock),
  ]);
  return el(
    "article",
    { class: "card" },
    el(
      "div",
      { class: "card-head" },
      el("h3", { class: "card-title", text: title }),
      el("span", { class: "card-date", text: shortDate(card.date) }),
    ),
    body,
    el(
      "div",
      { class: "source" },
      "Source: ",
      el("a", { href: card.source.url, target: "_blank", rel: "noopener", text: card.source.label }),
      ` · checked ${checkedTime(card.source.checkedAt)}. Dietary tags are Dining's labels; ask staff about allergies.`,
    ),
  );
}

function officeCard(card) {
  const url = new URL(card.url);
  const shown = (url.host.replace(/^www\./, "") + url.pathname).replace(/\/$/, "");
  const checked = new Date(`${card.source.checkedOn}T12:00:00`).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
  return el(
    "article",
    { class: "card" },
    el(
      "a",
      { class: "office", href: card.url, target: "_blank", rel: "noopener" },
      el("span", { class: "office-name", text: card.name }),
      el("span", { class: "chevron", "aria-hidden": "true", text: "›" }),
      el("span", { class: "office-url", text: shown }),
    ),
    el("div", { class: "source", text: `Office link checked against middlebury.edu on ${checked}.` }),
  );
}

function jobsCard(card) {
  const rows = card.jobs.map((j) =>
    el(
      "li",
      { class: "row" },
      el("div", { class: "row-main" }, el("a", { href: j.url, target: "_blank", rel: "noopener", text: j.title })),
      el("div", { class: "row-meta", text: [j.department, j.type, j.posted && `posted ${j.posted}`].filter(Boolean).join(" · ") }),
    ),
  );
  const more = card.total > card.jobs.length ? ` Showing ${card.jobs.length} of ${card.total}.` : "";
  return el(
    "article",
    { class: "card" },
    cardHead("Open jobs"),
    rows.length ? el("ul", { class: "rows" }, rows) : el("p", { class: "status", text: "No matching jobs on the board." }),
    sourceLine(card.source, `${more} Apply on the board.`),
  );
}

function studyRoomsCard(card) {
  const rows = card.rooms.map((r) =>
    el(
      "li",
      { class: "row" },
      el("div", { class: "row-main", text: `${r.name}${r.capacity ? ` · holds ${r.capacity}` : ""}` }),
      el("div", { class: r.free.length ? "row-meta" : "row-meta note", text: r.free.length ? `Free ${r.free.join(", ")}` : "Nothing free" }),
    ),
  );
  const day = new Date(`${card.date}T12:00:00`).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
  return el(
    "article",
    { class: "card" },
    cardHead("Study rooms, Davis Library", `${day}, from ${card.from}`),
    rows.length ? el("ul", { class: "rows" }, rows) : el("p", { class: "status", text: "No room fits." }),
    sourceLine(card.source, " Rooms can be booked at any moment; book on LibCal with your Middlebury login."),
  );
}

// A link out to RateMyProfessors. The app never reads the reviews, and the card says so.
function reviewsCard(card) {
  return el(
    "article",
    { class: "card" },
    el(
      "a",
      { class: "office", href: card.url, target: "_blank", rel: "noopener" },
      el("span", { class: "office-name", text: `${card.professor} on RateMyProfessors` }),
      el("span", { class: "chevron", "aria-hidden": "true", text: "›" }),
      el("span", { class: "office-url", text: "ratemyprofessors.com" }),
    ),
    el(
      "div",
      { class: "source" },
      "Student reviews: unofficial and unverified, not from Middlebury. Middleburity doesn't read them. ",
      el("a", { href: card.profile, target: "_blank", rel: "noopener", text: "Middlebury profile" }),
    ),
  );
}

// A Google Maps search for a kind of business. The app never reads or ranks what it finds.
function mapSearchCard(card) {
  return el(
    "article",
    { class: "card" },
    el(
      "a",
      { class: "office", href: card.url, target: "_blank", rel: "noopener" },
      el("span", { class: "office-name", text: `Search Google Maps: ${card.what} near ${card.place}` }),
      el("span", { class: "chevron", "aria-hidden": "true", text: "›" }),
      el("span", { class: "office-url", text: "google.com/maps" }),
    ),
    el("div", { class: "source" }, "A map search, not a Middlebury source. Middleburity doesn't see or rank the results."),
  );
}

// ---------- Games, events, directions ----------

const TZ = "America/New_York";
const dayTime = { timeZone: TZ, weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" };
const timeOnly = { timeZone: TZ, hour: "numeric", minute: "2-digit" };

function sourceLine(source, extra = "") {
  return el(
    "div",
    { class: "source" },
    "Source: ",
    el("a", { href: source.url, target: "_blank", rel: "noopener", text: source.label }),
    ` · checked ${checkedTime(source.checkedAt)}.${extra}`,
  );
}

function cardHead(title, aside) {
  return el("div", { class: "card-head" }, el("h3", { class: "card-title", text: title }), aside ? el("span", { class: "card-date", text: aside }) : null);
}

function gameWhen(game) {
  if (game.allDay) {
    const day = new Date(`${game.start}T12:00:00Z`).toLocaleDateString("en-US", { timeZone: TZ, weekday: "short", month: "short", day: "numeric" });
    return `${day} · no time posted`;
  }
  return new Date(game.start).toLocaleString("en-US", dayTime);
}

function gamesCard(card) {
  const rows = card.games.map((g) => {
    const label = `${g.sport} ${g.home ? "vs" : "at"} ${g.opponent}`;
    const where = g.home ? g.venue ?? "Middlebury" : g.place ?? "location not posted";
    const outcome = g.result ? { W: "win", L: "loss", T: "tie" }[g.result[0]] ?? "" : "";
    return el(
      "li",
      { class: "row" },
      el(
        "div",
        { class: "row-main" },
        el("a", { href: g.url, target: "_blank", rel: "noopener", text: label }),
        g.result ? el("span", { class: `result ${outcome}`, text: g.result }) : null,
      ),
      el("div", { class: "row-meta", text: `${gameWhen(g)} · ${g.home ? "Home" : "Away"}, ${where}` }),
    );
  });
  return el(
    "article",
    { class: "card" },
    cardHead(card.title),
    rows.length ? el("ul", { class: "rows" }, rows) : el("p", { class: "status", text: "No games found." }),
    sourceLine(card.source),
  );
}

function eventWhen(e) {
  const start = new Date(e.start).toLocaleString("en-US", dayTime);
  return e.end ? `${start} – ${new Date(e.end).toLocaleTimeString("en-US", timeOnly)}` : start;
}

function eventsCard(card) {
  const rows = card.events.map((e) =>
    el(
      "li",
      { class: "row" },
      el("div", { class: "row-main" }, el("a", { href: e.url, target: "_blank", rel: "noopener", text: e.name })),
      el("div", { class: "row-meta", text: [eventWhen(e), e.location, e.org].filter(Boolean).join(" · ") }),
    ),
  );
  const more = card.total > card.events.length ? `${card.total} posted` : null;
  return el(
    "article",
    { class: "card" },
    cardHead(card.title, more),
    rows.length ? el("ul", { class: "rows" }, rows) : el("p", { class: "status", text: "Nothing else posted for today." }),
    sourceLine(card.source, card.note ?? " Posted by the groups hosting them."),
  );
}

function directionsCard(card) {
  const route = card.from ? `${card.from} → ${card.to}` : `To ${card.to}, from where you are`;
  return el(
    "article",
    { class: "card" },
    cardHead("Walking directions"),
    el(
      "div",
      { class: "card-body" },
      el("p", { class: "route", text: route }),
      card.straightLineMiles !== null ? el("p", { class: "muted small", text: `${card.straightLineMiles} mi in a straight line. The walk is a bit longer.` }) : null,
      card.note ? el("p", { class: "note", text: card.note }) : null,
      el("a", { class: "button", href: card.url, target: "_blank", rel: "noopener", text: "Open in Google Maps" }),
      card.venuePage ? el("a", { class: "link-after", href: card.venuePage, target: "_blank", rel: "noopener", text: "Venue page" }) : null,
    ),
    el(
      "div",
      { class: "source" },
      el("a", { href: card.source.url, target: "_blank", rel: "noopener", text: card.source.label }),
      `, map data as of ${card.source.checkedOn}. The button opens Google Maps; nothing is sent until you tap it.`,
    ),
  );
}

function monthYear(iso) {
  return new Date(`${iso}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", year: "numeric", timeZone: "UTC" });
}

function pagesCard(card) {
  const rows = card.pages.map((p) =>
    el(
      "li",
      { class: "row" },
      el("div", { class: "row-main" }, el("a", { href: p.url, target: "_blank", rel: "noopener", text: p.title })),
      el("div", {
        class: p.old ? "row-meta note" : "row-meta",
        text: [p.site, p.updated ? `Updated ${monthYear(p.updated)}${p.old ? " · over a year old" : ""}` : "No date on the page"].filter(Boolean).join(" · "),
      }),
    ),
  );
  const from = card.pages.some((p) => p.site) ? "From the sites above" : "From middlebury.edu";
  return el(
    "article",
    { class: "card" },
    cardHead("Sources"),
    rows.length ? el("ul", { class: "rows" }, rows) : el("p", { class: "status", text: "No matching pages." }),
    el("div", { class: "source", text: `${from}, as indexed on ${card.source.checkedOn}. Pages can change; the links go to the live versions.` }),
  );
}

function clubsCard(card) {
  const rows = card.clubs.map((c) =>
    el(
      "li",
      { class: "row" },
      el("div", { class: "row-main" }, el("a", { href: c.url, target: "_blank", rel: "noopener", text: c.name })),
      el("div", {
        class: "row-meta",
        text: [c.board ? "Board for this category" : c.categories[0], c.meets && `Meets ${c.meets}`, c.where].filter(Boolean).join(" · "),
      }),
      c.next &&
        el(
          "div",
          { class: "row-meta" },
          "Next: ",
          el("a", { href: c.next.url, target: "_blank", rel: "noopener", text: c.next.name }),
          ` · ${[eventWhen(c.next), c.next.location].filter(Boolean).join(" · ")}`,
        ),
      c.join &&
        el("div", {
          class: "row-meta",
          text: [c.join.onPresence ? (c.join.approval ? "Request to join on its page · officers approve" : "Join on its page") : "Not joinable on MiddPresence", c.contact && `Contact: ${c.contact}`].filter(Boolean).join(" · "),
        }),
    ),
  );
  return el(
    "article",
    { class: "card" },
    cardHead("Clubs", card.total > card.clubs.length ? `${card.total} match` : null),
    rows.length ? el("ul", { class: "rows" }, rows) : el("p", { class: "status", text: "No matching clubs." }),
    sourceLine(card.source, " Descriptions and meeting times are posted by the clubs."),
  );
}

// ---------- Hours and buses ----------

function hoursCard(card) {
  const rows = card.days.map((d) =>
    el(
      "li",
      { class: "row" },
      el("div", { class: "row-main", text: shortDate(d.date) }),
      el("div", { class: "row-meta", text: d.hours.length ? d.hours.join(" · ") : "Nothing posted" }),
    ),
  );
  return el("article", { class: "card" }, cardHead(card.place), el("ul", { class: "rows" }, rows), sourceLine(card.source, " Hours as the calendar lists them."));
}

// Timetable times are "HH:MM", and can run past 24:00 for trips after midnight.
function busTime(hhmm) {
  const [h, m] = hhmm.split(":").map(Number);
  return `${h % 12 || 12}:${String(m).padStart(2, "0")} ${h % 24 < 12 ? "AM" : "PM"}${h >= 24 ? " (next day)" : ""}`;
}

function busCard(card) {
  const rows = card.departures.map((d) =>
    el(
      "li",
      { class: "row" },
      el("div", { class: "row-main" }, el("a", { href: d.url, target: "_blank", rel: "noopener", text: `${busTime(d.time)} · ${d.route}` })),
      el("div", { class: "row-meta", text: `From ${d.stop} → ${d.arrive.stop}, ${busTime(d.arrive.time)}` }),
    ),
  );
  const validTo = new Date(`${card.source.validTo}T12:00:00`).toLocaleDateString("en-US", { month: "short", day: "numeric" });
  return el(
    "article",
    { class: "card" },
    cardHead("Buses", shortDate(card.date)),
    rows.length ? el("ul", { class: "rows" }, rows) : el("p", { class: "status", text: card.covered ? "No matching departures." : "Not in the saved timetable." }),
    el(
      "div",
      { class: "source" },
      "Source: ",
      el("a", { href: card.source.url, target: "_blank", rel: "noopener", text: card.source.label }),
      `, valid through ${validTo}. Scheduled times, not live tracking.`,
    ),
  );
}

function tripsCard(card) {
  const rows = card.trips.map((legs) =>
    el(
      "li",
      { class: "row" },
      el("div", { class: "row-main", text: `${legs[0].leaves} → ${legs.at(-1).arrives}${legs.length > 1 ? " · 1 change" : " · direct"}` }),
      legs.map((l) =>
        el(
          "div",
          { class: "row-meta" },
          el("a", { href: l.url, target: "_blank", rel: "noopener", text: `${l.operator} ${l.route}` }),
          `: ${l.from} ${l.leaves} → ${l.to} ${l.arrives}`,
        ),
      ),
    ),
  );
  const published = new Date(`${card.source.published}T12:00:00`).toLocaleDateString("en-US", { month: "short", day: "numeric" });
  return el(
    "article",
    { class: "card" },
    cardHead(`${card.from} → ${card.to}`, shortDate(card.date)),
    rows.length ? el("ul", { class: "rows" }, rows) : el("p", { class: "status", text: "No trips in these timetables." }),
    el("div", { class: "source", text: `Source: ${card.source.label}, as published ${published}. Scheduled times; book and check on the operator's site.` }),
  );
}

function flightsCard(card) {
  const rows = card.flights.map((f) =>
    el(
      "li",
      { class: "row" },
      el("div", { class: "row-main", text: `${f.scheduled ?? ""} · ${card.direction === "arrival" ? "from" : "to"} ${f.city}` }),
      el("div", { class: f.status && !/on time|early|landed/i.test(f.status) ? "row-meta note" : "row-meta", text: [`${f.airline} ${f.flight}`, f.status, f.actual && `now ${f.actual}`, f.gate && `gate ${f.gate}`].filter(Boolean).join(" · ") }),
    ),
  );
  return el(
    "article",
    { class: "card" },
    cardHead(card.direction === "arrival" ? "Arrivals at BTV" : "Departures from BTV"),
    rows.length ? el("ul", { class: "rows" }, rows) : el("p", { class: "status", text: "No matching flights on the board." }),
    sourceLine(card.source, " The board covers about the next day."),
  );
}

function weatherCard(card) {
  const alerts = card.alerts.map((a) =>
    el("div", { class: "note" }, el("strong", { text: a.event }), a.until ? ` until ${new Date(a.until).toLocaleString("en-US", dayTime)}` : ""),
  );
  const rows = card.periods.map((p) =>
    el(
      "li",
      { class: "row" },
      el("div", { class: "row-main", text: `${p.name} · ${p.temperature}` }),
      el("div", { class: "row-meta", text: [p.summary, p.chance_of_precipitation && `${p.chance_of_precipitation} chance of precipitation`, p.wind].filter(Boolean).join(" · ") }),
    ),
  );
  return el(
    "article",
    { class: "card" },
    cardHead(card.hourly ? `${card.place}, next 12 hours` : card.place),
    alerts.length ? el("div", { class: "card-body" }, alerts) : null,
    el("ul", { class: "rows" }, rows),
    sourceLine(card.source, " A forecast, not a guarantee."),
  );
}

function renderCard(card) {
  if (card.type === "weather") return weatherCard(card);
  if (card.type === "trips") return tripsCard(card);
  if (card.type === "flights") return flightsCard(card);
  if (card.type === "hours") return hoursCard(card);
  if (card.type === "bus") return busCard(card);
  if (card.type === "menu") return menuCard(card);
  if (card.type === "pages") return pagesCard(card);
  if (card.type === "clubs") return clubsCard(card);
  if (card.type === "office") return officeCard(card);
  if (card.type === "reviews") return reviewsCard(card);
  if (card.type === "mapsearch") return mapSearchCard(card);
  if (card.type === "jobs") return jobsCard(card);
  if (card.type === "studyrooms") return studyRoomsCard(card);
  if (card.type === "games") return gamesCard(card);
  if (card.type === "events") return eventsCard(card);
  if (card.type === "directions") return directionsCard(card);
  return null;
}

// ---------- Answer text ----------

// Just enough formatting for short answers: paragraphs, "- " lists, **bold**.
function inline(text) {
  return text.split(/\*\*(.+?)\*\*/g).map((part, i) => (i % 2 ? el("strong", { text: part }) : part));
}

function answerNodes(text) {
  return text
    .split(/\n\s*\n/)
    .filter((block) => block.trim())
    .map((block) => {
      const lines = block.split("\n").filter((l) => l.trim());
      if (lines.every((l) => /^\s*[-*•]\s+/.test(l))) {
        return el("ul", {}, lines.map((l) => el("li", {}, inline(l.replace(/^\s*[-*•]\s+/, "")))));
      }
      return el("p", {}, inline(lines.join(" ")));
    });
}

// ---------- Asking ----------

function setBusy(busy) {
  $("#q").disabled = busy;
  $("#ask .send").disabled = busy;
}

// The friends-only access code, remembered on this device only. Storage can be blocked
// (private windows, strict settings), so every read and write is allowed to fail.
const CODE_KEY = "middleburity-access-code";
function savedCode() {
  try {
    return localStorage.getItem(CODE_KEY) ?? "";
  } catch {
    return sessionCode;
  }
}
let sessionCode = "";
function saveCode(code) {
  sessionCode = code;
  try {
    localStorage.setItem(CODE_KEY, code);
  } catch {
    // Kept for this visit only.
  }
}

// Shown in place of an answer when the server wants the access code; asks the question again once it's saved.
function codePrompt(answer, question, message) {
  const input = el("input", { type: "password", class: "code-input", placeholder: "Access code", "aria-label": "Access code", autocomplete: "off" });
  const form = el("form", { class: "code-form" }, input, el("button", { type: "submit", class: "code-button", text: "Continue" }));
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    if (!input.value.trim()) return;
    saveCode(input.value.trim());
    answer.closest(".qa").remove();
    ask(question);
  });
  answer.className = "a";
  answer.replaceChildren(el("p", { text: message }), form);
  input.focus();
}

// Feedback on an answer (👍 / 👎): nothing is sent until a thumb is tapped and Send is pressed
// (src/feedback.js). The form says exactly what goes, since it's the one thing the app keeps.
function feedbackControl(feedback) {
  const wrap = el("div", { class: "feedback" });
  const thumb = (rating, emoji, label) => {
    const b = el("button", { type: "button", class: "thumb", "aria-label": label, title: label, text: emoji });
    b.addEventListener("click", () => openForm(rating));
    return b;
  };
  const prompt = el("div", { class: "feedback-prompt" }, el("span", { class: "muted small", text: "Was this helpful?" }), thumb("up", "👍", "Helpful"), thumb("down", "👎", "Not helpful"));

  function openForm(rating) {
    const up = rating === "up";
    const note = el("textarea", {
      class: "feedback-note",
      rows: "2",
      maxlength: "1000",
      placeholder: up ? "What was good? (optional)" : "What was wrong? (optional)",
      "aria-label": up ? "What was good" : "What was wrong",
    });
    const send = el("button", { type: "submit", class: "code-button", text: `Send ${up ? "👍" : "👎"}` });
    const cancel = el("button", { type: "button", class: "link-button", text: "Cancel" });
    const status = el("p", { class: "muted small", role: "status" });
    const form = el(
      "form",
      { class: "feedback-form" },
      el("p", { class: "muted small", text: "Sends this question and answer (plus the earlier ones in this conversation), your rating and your note to Middleburity's developer. Nothing about who you are. Kept 60 days." }),
      note,
      el("div", { class: "feedback-actions" }, send, cancel),
      status,
    );
    cancel.addEventListener("click", () => wrap.replaceChildren(prompt));
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      send.disabled = true;
      try {
        const headers = { "content-type": "application/json" };
        if (savedCode()) headers["x-access-code"] = savedCode();
        const res = await fetch("/api/feedback", { method: "POST", headers, body: JSON.stringify({ ...feedback, rating, note: note.value }) });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || "Couldn't send the feedback. Try again.");
        wrap.replaceChildren(el("p", { class: "muted small", text: "Thanks for the feedback." }));
      } catch (err) {
        status.textContent = err.message;
        send.disabled = false;
      }
    });
    wrap.replaceChildren(form);
    note.focus();
  }

  wrap.append(prompt);
  return wrap;
}

async function ask(question) {
  question = question.trim();
  if (!question) return;

  $("#suggestions").hidden = true;
  $("#thread-tools").hidden = false;
  const answer = el("div", { class: "a" }, el("p", { class: "muted thinking", text: "Checking" }));
  const block = el("div", { class: "qa" }, el("p", { class: "q", text: question }), answer);
  $("#thread").prepend(block);
  setBusy(true);

  const messages = [...history, { role: "user", content: question }];
  try {
    const headers = { "content-type": "application/json" };
    if (savedCode()) headers["x-access-code"] = savedCode();
    const res = await fetch("/api/chat", { method: "POST", headers, body: JSON.stringify({ messages }) });
    const data = await res.json().catch(() => ({}));
    if (res.status === 401 && data.needsCode) {
      codePrompt(answer, question, savedCode() ? "That code didn't work. Check it and try again." : data.error);
      return;
    }
    if (!res.ok) throw new Error(data.error || "Something went wrong. Try again.");

    answer.replaceChildren(...answerNodes(data.answer));
    for (const card of data.cards ?? []) {
      const node = renderCard(card);
      if (node) block.append(node);
    }
    block.append(
      feedbackControl({
        question,
        answer: data.answer,
        context: history.slice(-4),
        tools: data.tools,
        cards: (data.cards ?? []).map((c) => c.type),
        model: data.model,
      }),
    );
    history.push({ role: "user", content: question }, { role: "assistant", content: data.answer });
    history.splice(0, Math.max(0, history.length - MAX_HISTORY));
  } catch (err) {
    answer.className = "a error";
    answer.replaceChildren(el("p", { text: err.message }));
  } finally {
    setBusy(false);
    if (!document.querySelector(".code-input")) $("#q").focus();
  }
}

$("#ask").addEventListener("submit", (event) => {
  event.preventDefault();
  const input = $("#q");
  const question = input.value;
  input.value = "";
  ask(question);
});

// Enter sends. Handled explicitly rather than left to the browser's implicit form submit,
// and skipped mid-composition so IME users can confirm characters with Enter.
$("#q").addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.isComposing) {
    event.preventDefault();
    $("#ask").requestSubmit();
  }
});

$("#suggestions").addEventListener("click", (event) => {
  const chip = event.target.closest(".chip");
  if (chip) ask(chip.textContent);
});

$("#clear").addEventListener("click", () => {
  history.length = 0;
  $("#thread").replaceChildren();
  $("#thread-tools").hidden = true;
  $("#suggestions").hidden = false;
  $("#q").focus();
});

// ---------- Today ----------

async function loadToday() {
  const target = $("#today-body");
  try {
    const res = await fetch("/api/today");
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    const down = (what) => el("p", { class: "muted small", text: `Couldn't load ${what} right now.` });
    target.replaceChildren(
      data.dining ? menuCard(data.dining, data.dining.label) : down("today's menus"),
      data.events ? eventsCard(data.events) : down("today's events"),
      data.games ? gamesCard(data.games) : down("the game schedule"),
    );
  } catch {
    target.replaceChildren(el("p", { class: "muted", text: "Couldn't load today's info. Check your connection." }));
  }
}

loadToday();
