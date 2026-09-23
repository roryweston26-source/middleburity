// Dining hall menus from Middlebury Dining Services' Nutrislice feed.
// The feed is public but undocumented: if Nutrislice changes its shape, parseDay() is
// where it breaks, and tests/check-feeds.js is how you find out.
import { addDays, campusDate, campusHour } from "../campus-time.js";
import { ToolInputError } from "./errors.js";
import { USER_AGENT } from "../user-agent.js";

const API = "https://middlebury.api.nutrislice.com/menu/api/weeks/school";
const WEB = "https://middlebury.nutrislice.com/menu";
const CACHE_MS = 30 * 60 * 1000;

// Meal types per hall, from the feed's own school list (checked 2026-09-21).
export const HALLS = {
  proctor: { slug: "proctor-dining-hall", name: "Proctor", meals: ["breakfast", "lunch", "dinner"] },
  ross: { slug: "ross-dining-hall", name: "Ross", meals: ["breakfast", "lunch", "dinner", "late-night"] },
  atwater: { slug: "atwater-dining-hall", name: "Atwater", meals: ["lunch", "dinner"] },
};
export const MEALS = ["breakfast", "lunch", "dinner", "late-night"];

export const SOURCE_LABEL = "Middlebury Dining Services menus";
const TAG_NOTE = "Dietary tags are Dining Services' labels, not allergy guarantees. Anyone with an allergy should check with staff at the station.";

const cache = new Map();
export function clearDiningCache() {
  cache.clear();
}

export function menuWebUrl(hall, meal, date) {
  return `${WEB}/${HALLS[hall].slug}/${meal}/${date}`;
}

// The feed serves a Sunday-to-Saturday week, so one fetch covers seven days.
function weekStart(date) {
  const dayOfWeek = new Date(`${date}T12:00:00Z`).getUTCDay();
  return addDays(date, -dayOfWeek);
}

async function fetchWeek(slug, meal, date) {
  const start = weekStart(date);
  const key = `${slug}/${meal}/${start}`;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.data;

  const [y, m, d] = start.split("-");
  const res = await fetch(`${API}/${slug}/menu-type/${meal}/${y}/${m}/${d}/?format=json`, {
    headers: { accept: "application/json", "user-agent": USER_AGENT },
    signal: AbortSignal.timeout(8000),
  });
  // 404 means this hall has no menu of this type at all.
  const data = res.status === 404 ? { days: [] } : res.ok ? await res.json() : null;
  if (!data) throw new Error(`menu feed returned ${res.status}`);
  cache.set(key, { at: Date.now(), data });
  return data;
}

// One day of feed items -> [{ name: "Main Street", items: [{ name, tags }] }]
export function parseDay(day) {
  const stations = [];
  let current = null;
  for (const item of day?.menu_items ?? []) {
    if (item.is_section_title || item.is_station_header) {
      const title = item.text?.trim();
      if (title) {
        current = { name: title, items: [] };
        stations.push(current);
      }
      continue;
    }
    const name = item.food?.name?.trim();
    if (!name) continue;
    if (!current) {
      current = { name: "Menu", items: [] };
      stations.push(current);
    }
    const tags = (item.food.icons?.food_icons ?? []).map((icon) => icon.name).filter(Boolean);
    current.items.push(tags.length ? { name, tags } : { name });
  }
  return stations.filter((s) => s.items.length > 0);
}

export async function getMenus({ date, meal, halls } = {}) {
  const day = date ?? campusDate();
  const hallKeys = halls?.length ? halls : Object.keys(HALLS);
  const meals = meal ? [meal] : MEALS;

  const jobs = [];
  for (const hall of hallKeys) {
    for (const m of meals) {
      // Asking for "late-night" everywhere shouldn't list two halls that never have it.
      if (!HALLS[hall].meals.includes(m) && !(meal && halls?.length)) continue;
      jobs.push({ hall, meal: m });
    }
  }

  const menus = await Promise.all(
    jobs.map(async ({ hall, meal: m }) => {
      const base = { hall, hallName: HALLS[hall].name, meal: m, url: menuWebUrl(hall, m, day) };
      if (!HALLS[hall].meals.includes(m)) return { ...base, status: `no ${m} menu in the feed` };
      try {
        const week = await fetchWeek(HALLS[hall].slug, m, day);
        const stations = parseDay(week.days?.find((d) => d.date === day));
        if (!stations.length) return { ...base, status: "no menu posted for this day (the hall may be closed)" };
        return { ...base, stations };
      } catch {
        return { ...base, status: "couldn't load this menu right now" };
      }
    }),
  );

  return { date: day, checkedAt: new Date().toISOString(), menus };
}

// "Maghmour (Roasted Eggplant Stew) [Vegan]" keeps the model's copy compact.
function forModel(result) {
  return JSON.stringify({
    date: result.date,
    source: SOURCE_LABEL,
    note: TAG_NOTE,
    menus: result.menus.map((m) =>
      m.stations
        ? {
            hall: m.hallName,
            meal: m.meal,
            stations: m.stations.map((s) => ({
              station: s.name,
              items: s.items.map((i) => (i.tags ? `${i.name} [${i.tags.join(", ")}]` : i.name)),
            })),
          }
        : { hall: m.hallName, meal: m.meal, status: m.status },
    ),
  });
}

export function menuCard(result) {
  return {
    type: "menu",
    date: result.date,
    menus: result.menus,
    source: { label: SOURCE_LABEL, url: WEB, checkedAt: result.checkedAt },
  };
}

function validate(input) {
  const out = {};
  if (input.date !== undefined) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(input.date)) throw new ToolInputError("date must be YYYY-MM-DD");
    out.date = input.date;
  }
  if (input.meal !== undefined) {
    if (!MEALS.includes(input.meal)) throw new ToolInputError(`meal must be one of ${MEALS.join(", ")}`);
    out.meal = input.meal;
  }
  if (input.halls !== undefined) {
    if (!Array.isArray(input.halls) || input.halls.some((h) => !HALLS[h])) {
      throw new ToolInputError(`halls must be a list drawn from ${Object.keys(HALLS).join(", ")}`);
    }
    out.halls = input.halls;
  }
  return out;
}

export const diningTool = {
  definition: {
    name: "get_dining_menu",
    description:
      "Look up the posted menu for Middlebury's three dining halls (Proctor, Ross, Atwater) from Dining Services' official menu feed. " +
      "Use it for any question about what food is being served, which hall to go to, or dietary options. " +
      "Returns each hall's stations and items with Dining's dietary tags (e.g. Vegan, Vegetarian, Dairy, Wheat, Local Ingredient). " +
      "Menus are posted about a week ahead. This feed has no hours and none of the campus retail spots (the Grille, Crossroads Café, Midd Express and others). " +
      "When someone wants a kind of food, check both: this feed for the halls, and search_pages for what the retail spots serve and when they're open (Dining Services' retail page). " +
      "For dining hall hours, use search_pages too, since Dining Services posts its regular hours there. " +
      "If the question doesn't name a meal, go by the time: roughly breakfast before 10am, lunch before 2pm, dinner before 8pm. " +
      "Those cutoffs are only for picking a meal. Never say whether a hall is open or when a meal ends from this feed alone; check the posted hours with search_pages.",
    input_schema: {
      type: "object",
      properties: {
        date: { type: "string", description: "Day to look up, YYYY-MM-DD, Vermont time. Omit for today." },
        meal: { type: "string", enum: MEALS, description: "Omit to get every meal that day." },
        halls: {
          type: "array",
          items: { type: "string", enum: Object.keys(HALLS) },
          description: "Omit for all three halls.",
        },
      },
      additionalProperties: false,
    },
  },
  async run(input) {
    const result = await getMenus(validate(input));
    return { content: forModel(result), card: menuCard(result) };
  },
};

// Home screen card. Meal cutoffs are rough guesses, not posted hours, so the card
// names the meal ("Dinner tonight") and never claims a hall is open right now.
export async function todaysMenus(now = new Date()) {
  const hour = campusHour(now);
  const today = campusDate(now);
  const [meal, date, label] =
    hour < 10 ? ["breakfast", today, "Breakfast today"]
    : hour < 14 ? ["lunch", today, "Lunch today"]
    : hour < 20 ? ["dinner", today, "Dinner tonight"]
    : ["breakfast", addDays(today, 1), "Breakfast tomorrow"];
  const result = await getMenus({ date, meal });
  return { ...menuCard(result), label };
}
