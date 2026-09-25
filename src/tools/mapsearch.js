// A Google Maps search link for a kind of local business (a barber, a pharmacy, late-night
// pizza), shown as a card. For the everyday errands Middlebury's pages don't cover: the answer
// says the pages don't list it, and the card lets the student look for themselves. Like the
// RateMyProfessors link, Middleburity never reads, ranks or recommends what the search finds;
// the server builds the link, so the model can't invent one, and the search is for a kind of
// business, never a named one the model remembers.
import { ToolInputError } from "./errors.js";

// Towns students actually go to, all Vermont. Middlebury is the default.
export const TOWNS = ["Middlebury", "Burlington", "Vergennes", "Bristol", "Brandon", "Rutland"];
const MAX_LENGTH = 40;

// Maps URLs (developers.google.com/maps/documentation/urls): opens a search in the app or browser.
export const mapSearchUrl = (query) => `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(query)}`;

export const mapSearchTool = {
  displayOnly: true,
  definition: {
    name: "get_map_search",
    description:
      "A Google Maps search card for a kind of local business or service near campus (barber, pharmacy, pizza, dry cleaner, car repair), for when Middlebury's pages don't list one. " +
      "Search Middlebury's pages first; they list some local banks, phone stores and thrift shops. " +
      "You can't see the results: never name, rank or recommend a business from memory, and say plainly that you can't judge which is best. " +
      "Give a kind of business, never a business name.",
    input_schema: {
      type: "object",
      properties: {
        what: { type: "string", description: 'The kind of business, a few words, e.g. "barber", "pharmacy", "late night pizza".' },
        town: { type: "string", enum: TOWNS, description: "Vermont town to search near. Default Middlebury." },
      },
      required: ["what"],
      additionalProperties: false,
    },
  },
  async run(input) {
    const what = typeof input.what === "string" ? input.what.trim().replace(/\s+/g, " ") : "";
    if (!what) throw new ToolInputError("what must name a kind of business");
    if (what.length > MAX_LENGTH || !/^[\p{L}\s'&-]+$/u.test(what)) {
      throw new ToolInputError(`what must be a few plain words for a kind of business, like "barber" (no numbers, links or punctuation)`);
    }
    const town = input.town ?? "Middlebury";
    if (!TOWNS.includes(town)) throw new ToolInputError(`town must be one of ${TOWNS.join(", ")}`);
    const place = `${town}, VT`;
    return {
      content: JSON.stringify({ search: `${what} near ${place}`, link: "shown to the student as a card", note: "You can't see the results. Don't name or rank businesses." }),
      card: { type: "mapsearch", what, place, url: mapSearchUrl(`${what} near ${place}`) },
    };
  },
};
