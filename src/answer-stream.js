// Streaming an answer to the page as the model writes it (2026-11-10). The page shows text as
// it arrives, then swaps in the finished answer and its cards from the server's last message,
// so anything this lets through early is only ever on screen for a moment.
//
// What it holds back:
// - the word being written, until a space follows it, so a "Sources:" line is caught whole;
// - everything from a "Sources:" marker on, which applySources (chat.js) strips at the end.
//   A plain "sources:" in a sentence also stops the stream; the finished answer then fills in.

const MARK = /(^|\s)[-*]?\s*\**sources?\**\s*:/i;

export class AnswerStream {
  constructor(emit) {
    this.emit = emit;
    this.text = "";
    this.sent = 0;
    this.stopped = false;
  }

  push(chunk) {
    this.text += chunk;
    if (this.stopped) return;
    // Every search looks only at the tail not yet sent (plus a few characters before it).
    // Searching the whole answer on every piece grew with the square of its length: ~12 ms of
    // CPU for a 1,000-piece answer, over the Workers free plan's 10 ms.
    // The scan starts at a word boundary so the end of "resources:" can't look like "sources:".
    let from = Math.max(0, this.sent - 30);
    while (from > 0 && !/\s/.test(this.text[from - 1])) from--;
    const mark = this.text.slice(from).match(MARK);
    let end;
    if (mark) {
      end = from + mark.index + mark[1].length;
      this.stopped = true;
    } else {
      const tail = this.text.slice(this.sent);
      let cut = tail.length;
      while (cut > 0 && !/\s/.test(tail[cut - 1])) cut--;
      end = this.sent + cut;
      // A line that's only a bullet so far ("- ") waits too: it may turn into "- **Sources:**".
      const lineStart = this.sent + tail.lastIndexOf("\n", cut - 1) + 1;
      if (/^\s*[-*•]?\s*\**\s*$/.test(this.text.slice(lineStart, end))) end = lineStart;
    }
    if (end > this.sent) {
      this.emit(this.text.slice(this.sent, end));
      this.sent = end;
    }
  }

  // Whether the page has been shown any of this round's text.
  get started() {
    return this.sent > 0;
  }
}

// What the page says while lookups run. Plain words for students, never a tool's name.
const STATUS = {
  get_dining_menu: "Checking dining menus",
  search_pages: "Searching Middlebury's pages",
  get_games: "Checking the athletics schedule",
  get_events: "Checking campus events",
  get_college_events: "Checking the college calendar",
  get_clubs: "Looking through clubs",
  get_hours: "Checking hours",
  get_bus: "Checking bus times",
  get_trains_and_buses: "Checking trains and buses",
  get_flights: "Checking flights",
  get_weather: "Checking the forecast",
  get_jobs: "Checking the job board",
  get_study_rooms: "Checking study rooms",
  get_directions: "Getting a walking link",
  get_office: "Finding the right office",
  get_map_search: "Making a map search",
  get_reviews_link: "Finding the review link",
};

export function statusFor(names) {
  const said = [...new Set(names.map((n) => STATUS[n]).filter(Boolean))];
  return said.length ? said.join(", ") : "Looking that up";
}
