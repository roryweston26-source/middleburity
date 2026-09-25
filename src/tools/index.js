// Every data source the model can check. Adding a source = adding one entry here.
// A tool returns { content } for the model and, optionally, { card } for the app to
// show as-is, so what's on screen is the source's own data, not the model's retelling.
import { athleticsTool } from "./athletics.js";
import { busTool } from "./bus.js";
import { clubsTool } from "./clubs.js";
import { collegeEventsTool } from "./college-events.js";
import { diningTool } from "./dining.js";
import { directionsTool } from "./directions.js";
import { ToolInputError } from "./errors.js";
import { eventsTool } from "./events.js";
import { flightsTool } from "./flights.js";
import { hoursTool } from "./hours.js";
import { intercityTool } from "./intercity.js";
import { jobsTool } from "./jobs.js";
import { officesTool } from "./offices.js";
import { pagesTool } from "./pages.js";
import { reviewsTool } from "./reviews.js";
import { studyRoomsTool } from "./studyrooms.js";
import { weatherTool } from "./weather.js";

const TOOLS = [diningTool, athleticsTool, eventsTool, collegeEventsTool, clubsTool, hoursTool, weatherTool, busTool, intercityTool, flightsTool, pagesTool, directionsTool, officesTool, reviewsTool, jobsTool, studyRoomsTool];

export const TOOL_DEFINITIONS = TOOLS.map((t) => t.definition);

// Tools whose results the model doesn't need to read (they only add a card).
export function isDisplayOnly(name) {
  return TOOLS.some((t) => t.definition.name === name && t.displayOnly);
}

// env carries bindings such as DB (the page-search database); most tools ignore it.
export async function runTool(name, input, env = {}) {
  const tool = TOOLS.find((t) => t.definition.name === name);
  if (!tool) return { content: `There is no tool called ${name}.`, isError: true };
  try {
    return await tool.run(input ?? {}, env);
  } catch (err) {
    const why = err instanceof ToolInputError ? err.message : "the source couldn't be reached";
    return { content: `That lookup failed: ${why}.`, isError: true };
  }
}
