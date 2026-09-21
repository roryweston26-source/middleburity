// Every data source the model can check. Adding a source = adding one entry here.
// A tool returns { content } for the model and, optionally, { card } for the app to
// show as-is, so what's on screen is the source's own data, not the model's retelling.
import { diningTool } from "./dining.js";
import { ToolInputError } from "./errors.js";
import { officesTool } from "./offices.js";

const TOOLS = [diningTool, officesTool];

export const TOOL_DEFINITIONS = TOOLS.map((t) => t.definition);

// Tools whose results the model doesn't need to read (they only add a card).
export function isDisplayOnly(name) {
  return TOOLS.some((t) => t.definition.name === name && t.displayOnly);
}

export async function runTool(name, input) {
  const tool = TOOLS.find((t) => t.definition.name === name);
  if (!tool) return { content: `There is no tool called ${name}.`, isError: true };
  try {
    return await tool.run(input ?? {});
  } catch (err) {
    const why = err instanceof ToolInputError ? err.message : "the source couldn't be reached";
    return { content: `That lookup failed: ${why}.`, isError: true };
  }
}
