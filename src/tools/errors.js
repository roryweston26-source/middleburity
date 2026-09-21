// Thrown when the model sends a tool bad input. The message goes back to the model so it can
// fix the call; any other error is reported as "the source couldn't be reached".
export class ToolInputError extends Error {}
