// Flights at Burlington's airport (BTV), from the airport's own departures board
// (btv.aero's flight-status data). The board is a rolling window of about the next day, so
// this answers "what's flying from BTV" and "is my flight on time", not "what can I book for
// March": for that, and for fares and connections, the airline's site is the source.
import { ToolInputError } from "./errors.js";
import { USER_AGENT } from "../user-agent.js";

const FEED = "https://btv.aero/wp-json/btv/v1/flights";
const BOARD = "https://btv.aero/arrivals-departures/";
const CACHE_MS = 10 * 60 * 1000; // times and gates change through the day
export const SOURCE_LABEL = "Burlington International Airport flight board";

let cache = null;
export function clearFlightsCache() {
  cache = null;
}

export function normalizeFlight(raw) {
  return {
    direction: raw.type === "A" ? "arrival" : "departure",
    date: raw.date,
    airline: (raw.airline ?? "").trim(),
    flight: `${raw.airlineCode ?? ""} ${raw.flight ?? ""}`.trim(),
    city: (raw.city ?? "").trim(),
    scheduled: raw.scheduled || null,
    actual: raw.actual && raw.actual !== raw.scheduled ? raw.actual : null,
    status: (raw.status ?? "").replace(/^OnTime$/, "On Time") || null,
    gate: raw.gate || null,
  };
}

async function loadBoard() {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache;
  const res = await fetch(FEED, { headers: { accept: "application/json", "user-agent": USER_AGENT }, signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error(`flight board returned ${res.status}`);
  const json = await res.json();
  cache = { at: Date.now(), flights: (json.flights ?? []).map(normalizeFlight).filter((f) => f.city && f.date) };
  return cache;
}

const matches = (text, keyword) => {
  const have = text.toLowerCase();
  return keyword.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean).every((w) => have.includes(w));
};

export function searchBoard(flights, { direction = "departure", city, airline, limit = 12 }) {
  const all = flights.filter((f) => f.direction === direction);
  const hits = all.filter((f) => (!city || matches(f.city, city)) && (!airline || matches(`${f.airline} ${f.flight}`, airline)));
  const dates = all.map((f) => f.date).sort();
  return {
    covers: dates.length ? { from: dates[0], to: dates.at(-1) } : null,
    cities: [...new Set(all.map((f) => f.city))].sort(),
    total: hits.length,
    flights: hits.slice(0, limit),
  };
}

export const flightsTool = {
  definition: {
    name: "get_flights",
    description:
      "Flights on Burlington International Airport's (BTV) live departures and arrivals board: airline, flight number, city, scheduled and actual time, status and gate. " +
      "The board only covers about the next day and lists nonstop flights, so it shows where BTV's flights go right now, not every route, fare or connection. " +
      "If no flight on the board goes somewhere, say that the board shows none and name the cities it does show; don't claim which connections exist. " +
      "For getting to the airport from Middlebury, use get_trains_and_buses (Vermont Translines stops there) or search_pages (Tri-Valley's Regional Connections page).",
    input_schema: {
      type: "object",
      properties: {
        direction: { type: "string", enum: ["departures", "arrivals"], description: "Default departures." },
        city: { type: "string", description: "Words from the other city's name, e.g. \"chicago\", \"new york\"." },
        airline: { type: "string", description: "Airline name or flight number, e.g. \"delta\", \"UA 4575\"." },
      },
      additionalProperties: false,
    },
  },
  async run(input) {
    for (const k of ["city", "airline"]) if (input[k] !== undefined && typeof input[k] !== "string") throw new ToolInputError(`${k} must be a string`);
    const direction = input.direction === "arrivals" ? "arrival" : "departure";
    const { at, flights } = await loadBoard();
    const r = searchBoard(flights, { direction, city: input.city?.trim() || undefined, airline: input.airline?.trim() || undefined });
    const checkedAt = new Date(at).toISOString();
    return {
      content: JSON.stringify({
        source: SOURCE_LABEL,
        note: "A rolling board of about the next day, nonstop flights only. Times are Burlington (Eastern) time.",
        board_covers: r.covers ? `${r.covers.from} to ${r.covers.to}` : "nothing posted",
        [`${direction}_cities_on_board`]: r.cities,
        matching: r.total,
        flights: r.flights.map((f) => ({
          flight: `${f.airline} ${f.flight}`,
          [direction === "arrival" ? "from" : "to"]: f.city,
          date: f.date,
          scheduled: f.scheduled,
          ...(f.actual && { now_expected: f.actual }),
          status: f.status,
          ...(f.gate && { gate: f.gate }),
        })),
      }),
      card: {
        type: "flights",
        direction,
        flights: r.flights,
        source: { label: SOURCE_LABEL, url: BOARD, checkedAt },
      },
    };
  },
};
