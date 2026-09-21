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

function renderCard(card) {
  if (card.type === "menu") return menuCard(card);
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
    target.replaceChildren(menuCard(data.dining, data.dining.label));
  } catch {
    target.replaceChildren(el("p", { class: "muted", text: "Couldn't load today's menus. The dining feed may be down." }));
  }
}

loadToday();
