// Rebuilds src/data/places.js from OpenStreetMap: npm run build:places
// Run it by hand when campus buildings change; the app never calls OpenStreetMap at runtime.
// Data © OpenStreetMap contributors, available under the Open Database License (ODbL).
import { writeFile } from "node:fs/promises";

const BBOX = "43.995,-73.200,44.025,-73.160"; // campus plus downtown Middlebury
const QUERY = `[out:json][timeout:60];(
way["building"]["name"](${BBOX});relation["building"]["name"](${BBOX});
way["leisure"~"pitch|stadium|track|sports_centre|ice_rink"]["name"](${BBOX});
way["amenity"~"university|college|library|theatre|place_of_worship"]["name"](${BBOX});
);out center tags;`;
// Public Overpass servers are often busy; the script tries each and never writes a partial file.
const SERVERS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
  "https://overpass.private.coffee/api/interpreter",
];
const UA = "Middleburity/0.1 (student project; campus building extract; github.com/roryweston26-source/middleburity)";

// Only keep what OpenStreetMap itself marks as the college's, so a downtown shop can
// never be offered as a campus building.
function isCollege(tags) {
  return ["university", "college", "dormitory"].includes(tags.building) || /^Middlebury College$/.test(tags.operator ?? "");
}

// Athletic venues, named the way the athletics site names them, matched to OpenStreetMap
// only where OSM's own data confirms the match. Checked 2026-09-21.
const VENUE_MATCHES = [
  // OSM tags this field sport=field_hockey; the athletics site calls it Peter Kohn Field.
  { name: "Peter Kohn Field", osm: "Kohn All-weather Field", kind: "athletics" },
  // OSM links this pitch to Wikipedia's "Youngman Field at Alumni Stadium".
  { name: "Youngman Field at Alumni Stadium", osm: "Youngman Field", kind: "athletics" },
  // OSM's address, 219 South Main Street, is the one in the athletics site's footer.
  { name: "Peterson Family Athletics Complex", osm: "Peterson Family Athletics Complex", kind: "athletics" },
  { name: "Proctor Tennis Courts", osm: "Proctor Tennis Courts", kind: "athletics" },
  // Middlebury's visitor-parking page sends overnight guests to the "Mahaney Arts Center (MAC)" lot.
  { name: "Mahaney Arts Center", osm: "Kevin P. Mahaney '84 Center for the Arts", kind: "campus building" },
];

// Venues on the athletics site with no location that any source confirms. Directions to
// these say so and fall back to the athletics complex, rather than dropping a guessed pin.
const VENUES_WITHOUT_LOCATION = {
  "Pepin Gymnasium": "https://athletics.middlebury.edu/facilities/pepin-gymnasium/11",
  Natatorium: "https://athletics.middlebury.edu/facilities/natatorium/9",
  "Chip Kenyon '85 Arena": "https://athletics.middlebury.edu/facilities/chip-kenyon-85-arena/7",
  "Virtue Field House": "https://athletics.middlebury.edu/facilities/virtue-field-house/18",
  "South Street Field": "https://athletics.middlebury.edu/facilities/south-street-field/17",
  "Allan Dragone Track & Field Complex": "https://athletics.middlebury.edu/facilities/dragone-field/4",
  "Outdoor Tennis Courts": "https://athletics.middlebury.edu/facilities/middlebury-outdoor-tennis-courts/23",
  "Bostwick Family Squash Center": "https://athletics.middlebury.edu/facilities/bostwick-family-squash-center/1",
  "Nelson Recreation Center": "https://athletics.middlebury.edu/facilities/nelson-recreation-center/10",
  "Fitness Center": "https://athletics.middlebury.edu/facilities/fitness-center/5",
  "Baseball/Softball Complex": "https://athletics.middlebury.edu/facilities/baseball-softball-complex/22",
};

const KIND = { dormitory: "residence", university: "campus building", college: "campus building" };

async function fetchOsm() {
  for (const server of SERVERS) {
    try {
      const res = await fetch(server, {
        method: "POST",
        headers: { "user-agent": UA, "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ data: QUERY }),
        signal: AbortSignal.timeout(90000),
      });
      if (res.ok) return await res.json();
      console.warn(`${server}: ${res.status}, trying the next server`);
    } catch (err) {
      console.warn(`${server}: ${err.message}, trying the next server`);
    }
  }
  throw new Error("every Overpass server failed");
}

const osm = await fetchOsm();
const point = (el) => ({ lat: +(el.center ?? el).lat.toFixed(6), lon: +(el.center ?? el).lon.toFixed(6) });
const byName = new Map(osm.elements.map((el) => [el.tags.name, el]));

const places = osm.elements
  .filter((el) => isCollege(el.tags))
  .map((el) => ({ name: el.tags.name, kind: KIND[el.tags.building] ?? "campus building", ...point(el) }));

for (const venue of VENUE_MATCHES) {
  const el = byName.get(venue.osm);
  if (!el) throw new Error(`OpenStreetMap no longer has "${venue.osm}"; recheck VENUE_MATCHES`);
  const existing = places.findIndex((p) => p.name === venue.osm);
  if (existing >= 0) places.splice(existing, 1);
  places.push({ name: venue.name, kind: venue.kind, ...point(el), ...(venue.osm !== venue.name && { osmName: venue.osm }) });
}

places.sort((a, b) => a.name.localeCompare(b.name));
const dataAsOf = osm.osm3s?.timestamp_osm_base?.slice(0, 10) ?? "unknown";

const file = `// Generated by scripts/build-places.js. Don't edit by hand; rerun the script.
// Locations © OpenStreetMap contributors, Open Database License (ODbL): https://www.openstreetmap.org/copyright
export const PLACES_AS_OF = ${JSON.stringify(dataAsOf)};
export const PLACES = ${JSON.stringify(places, null, 1)};
export const VENUES_WITHOUT_LOCATION = ${JSON.stringify(VENUES_WITHOUT_LOCATION, null, 1)};
`;
await writeFile(new URL("../src/data/places.js", import.meta.url), file);
console.log(`Wrote ${places.length} places (OpenStreetMap data as of ${dataAsOf}).`);
