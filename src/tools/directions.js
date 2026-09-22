// Walking directions between campus places. The app doesn't route anything itself: it links
// to Google Maps with the two points, so the route comes from a real map, and nothing is sent
// to Google unless the person taps the link. Places come from src/data/places.js (OpenStreetMap).
import { PLACES, PLACES_AS_OF, VENUES_WITHOUT_LOCATION } from "../data/places.js";
import { ToolInputError } from "./errors.js";

const ATHLETICS_ADDRESS = "219 S. Main St."; // the address in the athletics site's footer
const FALLBACK = "Peterson Family Athletics Complex";

// Names students use that don't share a word with the official one.
const ALIASES = {
  "bi hall": "McCardell Bicentennial Hall",
  bihall: "McCardell Bicentennial Hall",
  "the library": "Davis Family Library",
  "main library": "Davis Family Library",
  mac: "Mahaney Arts Center",
  "the mac": "Mahaney Arts Center",
  "mahaney center": "Mahaney Arts Center",
  "kohn field": "Peter Kohn Field",
  "football field": "Youngman Field at Alumni Stadium",
};

const STOP = new Set(["the", "of", "at", "a", "an", "to"]);
const tokens = (s) =>
  s
    .toLowerCase()
    .replace(/['’]/g, "")
    .split(/[^a-z0-9]+/)
    .filter((w) => w && !STOP.has(w));

// Finds the place whose name contains every word of the query, preferring the shortest
// such name ("Proctor" -> "Proctor Hall" over "Proctor Tennis Courts").
export function findPlace(query) {
  const alias = ALIASES[query.trim().toLowerCase()];
  if (alias) return { place: PLACES.find((p) => p.name === alias) ?? null, alternatives: [] };
  const want = tokens(query);
  if (!want.length) return { place: null, alternatives: [] };
  const matches = PLACES.filter((p) => {
    const have = new Set(tokens(p.name));
    return want.every((w) => have.has(w));
  }).sort((a, b) => tokens(a.name).length - tokens(b.name).length);
  return { place: matches[0] ?? null, alternatives: matches.slice(1, 4).map((p) => p.name) };
}

export function findVenueWithoutLocation(query) {
  const want = tokens(query);
  const name = Object.keys(VENUES_WITHOUT_LOCATION).find((n) => {
    const have = new Set(tokens(n));
    return want.length && want.every((w) => have.has(w));
  });
  return name ? { name, page: VENUES_WITHOUT_LOCATION[name] } : null;
}

function miles(a, b) {
  const rad = (d) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLon = rad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 3958.8 * 2 * Math.asin(Math.sqrt(h));
}

export function mapsUrl(to, from) {
  const params = new URLSearchParams({ api: "1", destination: `${to.lat},${to.lon}`, travelmode: "walking" });
  if (from) params.set("origin", `${from.lat},${from.lon}`);
  return `https://www.google.com/maps/dir/?${params}`;
}

const source = { label: "Locations: OpenStreetMap contributors", url: "https://www.openstreetmap.org/copyright", checkedOn: PLACES_AS_OF };

export function directions({ to, from }) {
  let target = findPlace(to);
  let note = null;
  let venuePage = null;
  if (!target.place) {
    const venue = findVenueWithoutLocation(to);
    if (!venue) throw new ToolInputError(`"${to}" isn't in my list of campus places`);
    // No confirmed spot for this venue: point to the athletics complex and say so.
    venuePage = venue.page;
    note = `No confirmed location for ${venue.name}. These directions go to the ${FALLBACK} (${ATHLETICS_ADDRESS}); the venue's page may say more.`;
    target = { place: PLACES.find((p) => p.name === FALLBACK), alternatives: [], askedFor: venue.name };
  }
  let origin = null;
  if (from) {
    origin = findPlace(from);
    if (!origin.place) throw new ToolInputError(`"${from}" isn't in my list of campus places`);
  }
  const distance = origin ? Math.round(miles(origin.place, target.place) * 10) / 10 : null;
  return {
    to: target.place.name,
    ...(target.askedFor && { askedFor: target.askedFor }),
    from: origin?.place.name ?? null,
    straightLineMiles: distance,
    url: mapsUrl(target.place, origin?.place),
    note,
    venuePage,
    alternatives: [...(target.alternatives ?? []), ...(origin?.alternatives ?? [])],
  };
}

export const directionsTool = {
  definition: {
    name: "get_directions",
    description:
      "Get a walking-directions link between two campus places (residence halls, dining halls, academic buildings, the athletics complex, Peter Kohn Field, Youngman Field). " +
      "The app shows it as a Google Maps button. You can't see the route, so never describe turns or walking times; the straight-line distance is the only number you have. " +
      "If they ask from 'my dorm' without naming it, ask which dorm instead of guessing. Omit `from` to let their phone start from where they are. " +
      "If the result has a note (for example, that a venue has no confirmed location), tell the person what it says.",
    input_schema: {
      type: "object",
      properties: {
        to: { type: "string", description: 'Where they want to go, e.g. "Peter Kohn Field", "Proctor", "Bi Hall".' },
        from: { type: "string", description: 'Where they start, e.g. "Hepburn Hall". Optional.' },
      },
      required: ["to"],
      additionalProperties: false,
    },
  },
  async run(input) {
    if (typeof input.to !== "string" || !input.to.trim()) throw new ToolInputError("to is required");
    const d = directions({ to: input.to, from: typeof input.from === "string" && input.from.trim() ? input.from : undefined });
    return {
      content: JSON.stringify({
        to: d.to,
        ...(d.askedFor && { asked_for: d.askedFor }),
        from: d.from ?? "their current location",
        ...(d.straightLineMiles !== null && { straight_line_miles: d.straightLineMiles }),
        ...(d.note && { note: d.note }),
        ...(d.alternatives.length && { other_matches: d.alternatives }),
      }),
      card: { type: "directions", ...d, source },
    };
  },
};
