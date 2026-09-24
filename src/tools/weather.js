// Weather from the US National Weather Service (api.weather.gov): public-domain government
// data, free, no key. It asks every app to identify itself in the User-Agent, which we do.
// Two places: campus, and the Snow Bowl, whose forecast differs up on the mountain.
import { ToolInputError } from "./errors.js";
import { USER_AGENT } from "../user-agent.js";

const API = "https://api.weather.gov";
export const SOURCE_LABEL = "National Weather Service";
// Campus: McCullough Student Center (src/data/places.js, from OpenStreetMap). Snow Bowl: the
// point the Snow Bowl's own website uses for its weather.
export const PLACES = {
  campus: { name: "Middlebury campus", lat: 44.0083, lon: -73.1772 },
  "snow-bowl": { name: "Middlebury Snow Bowl", lat: 43.9425, lon: -72.9653 },
};
const GRID_MS = 24 * 60 * 60 * 1000; // which forecast grid a point is in hardly ever changes
const FORECAST_MS = 30 * 60 * 1000; // the forecast office updates a few times a day; alerts sooner

const cache = new Map();
export function clearWeatherCache() {
  cache.clear();
}

async function getJson(url, maxAge) {
  const hit = cache.get(url);
  if (hit && Date.now() - hit.at < maxAge) return hit;
  const res = await fetch(url, { headers: { accept: "application/geo+json", "user-agent": USER_AGENT }, signal: AbortSignal.timeout(10000) });
  if (!res.ok) throw new Error(`weather.gov returned ${res.status}`);
  const entry = { at: Date.now(), data: await res.json() };
  cache.set(url, entry);
  return entry;
}

// Hourly periods have no name, so they get their time: "6 PM Wed".
const hourLabel = (iso) =>
  new Date(iso).toLocaleString("en-US", { timeZone: "America/New_York", hour: "numeric", weekday: "short" }).replace(/^(\w+) (.+)$/, "$2 $1");

export function summarizePeriod(p) {
  return {
    name: p.name || hourLabel(p.startTime),
    start: p.startTime,
    temperature: `${p.temperature}°${p.temperatureUnit}`,
    ...(p.probabilityOfPrecipitation?.value != null && { chance_of_precipitation: `${p.probabilityOfPrecipitation.value}%` }),
    wind: `${p.windSpeed} ${p.windDirection}`.trim(),
    summary: p.shortForecast,
    detail: p.detailedForecast,
  };
}

export function summarizeAlert(a) {
  return {
    event: a.event,
    headline: a.headline,
    severity: a.severity,
    from: a.onset || a.effective,
    until: a.ends || a.expires,
    ...(a.instruction && { what_to_do: a.instruction.replace(/\s+/g, " ").trim().slice(0, 500) }),
  };
}

export async function getWeather(placeId, { hourly = false } = {}) {
  const place = PLACES[placeId];
  const point = (await getJson(`${API}/points/${place.lat},${place.lon}`, GRID_MS)).data.properties;
  const [forecast, alerts] = await Promise.all([
    getJson(hourly ? point.forecastHourly : point.forecast, FORECAST_MS),
    getJson(`${API}/alerts/active?point=${place.lat},${place.lon}`, FORECAST_MS),
  ]);
  const f = forecast.data.properties;
  return {
    place: place.name,
    checkedAt: new Date(Math.min(forecast.at, alerts.at)).toISOString(),
    updated: f.updateTime ?? f.generatedAt ?? null,
    periods: (f.periods ?? []).slice(0, hourly ? 12 : 8).map(summarizePeriod),
    alerts: (alerts.data.features ?? []).map((x) => summarizeAlert(x.properties)),
    url: `https://forecast.weather.gov/MapClick.php?lat=${place.lat}&lon=${place.lon}`,
  };
}

export const weatherTool = {
  definition: {
    name: "get_weather",
    description:
      "National Weather Service forecast and active alerts for campus or the Snow Bowl. " +
      "Say what the forecast says; no predictions of your own, and don't say whether classes or events are cancelled. " +
      "Pass on an alert's safety instructions; in an emergency, 911 comes first.",
    input_schema: {
      type: "object",
      properties: {
        place: { type: "string", enum: Object.keys(PLACES), description: "Default campus." },
        hourly: { type: "boolean", description: "Hour by hour for the next 12 hours instead of the multi-day forecast." },
      },
      additionalProperties: false,
    },
  },
  async run(input) {
    const placeId = input.place ?? "campus";
    if (!PLACES[placeId]) throw new ToolInputError(`place must be one of: ${Object.keys(PLACES).join(", ")}`);
    const w = await getWeather(placeId, { hourly: Boolean(input.hourly) });
    return {
      content: JSON.stringify({
        source: `${SOURCE_LABEL} forecast${w.updated ? `, updated ${w.updated}` : ""}`,
        place: w.place,
        note: "Times are Eastern. A forecast, not a guarantee.",
        alerts: w.alerts.length ? w.alerts : "none active",
        [input.hourly ? "next_12_hours" : "forecast"]: w.periods.map(({ start, ...rest }) => rest),
      }),
      card: {
        type: "weather",
        place: w.place,
        hourly: Boolean(input.hourly),
        alerts: w.alerts,
        periods: w.periods,
        source: { label: SOURCE_LABEL, url: w.url, checkedAt: w.checkedAt },
      },
    };
  },
};
