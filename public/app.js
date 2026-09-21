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
  return `${new Date(e.start).toLocaleString("en-US", dayTime)} – ${new Date(e.end).toLocaleTimeString("en-US", timeOnly)}`;
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
    sourceLine(card.source, " Posted by the groups hosting them."),
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

function renderCard(card) {
  if (card.type === "menu") return menuCard(card);
  if (card.type === "office") return officeCard(card);
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
    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ messages }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || "Something went wrong. Try again.");

    answer.replaceChildren(...answerNodes(data.answer));
    for (const card of data.cards ?? []) {
      const node = renderCard(card);
      if (node) block.append(node);
    }
    history.push({ role: "user", content: question }, { role: "assistant", content: data.answer });
    history.splice(0, Math.max(0, history.length - MAX_HISTORY));
  } catch (err) {
    answer.className = "a error";
    answer.replaceChildren(el("p", { text: err.message }));
  } finally {
    setBusy(false);
    $("#q").focus();
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
