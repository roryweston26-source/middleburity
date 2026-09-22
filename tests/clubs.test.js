import assert from "node:assert/strict";
import { test } from "node:test";
import { clearClubsCache, clubsTool, findClubs, getClubs, joinInfo, normalizeClub } from "../src/tools/clubs.js";
import { clearEventsCache } from "../src/tools/events.js";
import { stubFetch } from "./helpers.js";

const raw = [
  { name: "Middlebury Ski & Ride Club", uri: "middlebury-ski-ride-club", categories: ["Student Organizations", "Wellbeing & Outdoor Pursuits Organizations"], memberCount: 112, regularMeetingTime: "TBD", regularMeetingLocation: "TBD", description: "<p>Winter sports for everyone.</p>" },
  { name: "Club Tennis", uri: "club-tennis", categories: ["Club Sport & Recreation Organizations"], memberCount: 40, regularMeetingTime: "Mondays 8:30pm", regularMeetingLocation: "Tennis bubble", description: "Build your skills on the court." },
  { name: "Performing Arts Organizations", uri: "performing-arts-organizations", categories: ["Performing Arts Organizations"], memberCount: 4, description: "The board for performing arts groups." },
  { name: "The Middlebury Bobolinks", uri: "the-middlebury-bobolinks", categories: ["Performing Arts Organizations"], memberCount: 16, regularMeetingTime: "Tuesdays 6pm", regularMeetingLocation: "Mead", description: "An a cappella group." },
];
const clubs = raw.map(normalizeClub);

test("placeholder meeting details become 'not posted', not 'TBD'", () => {
  assert.equal(clubs[0].meets, null);
  assert.equal(clubs[0].where, null);
  assert.equal(clubs[1].meets, "Mondays 8:30pm");
});

test("the generic 'Student Organizations' category is dropped, and links go to the club's page", () => {
  assert.deepEqual(clubs[0].categories, ["Wellbeing & Outdoor Pursuits Organizations"]);
  assert.equal(clubs[0].url, "https://middlebury.presence.io/organization/middlebury-ski-ride-club");
  assert.equal(clubs[0].description, "Winter sports for everyone.");
});

test("category boards are marked as boards, not clubs", () => {
  assert.equal(clubs[2].board, true);
  assert.equal(clubs[3].board, false);
});

test("keywords match whole words: 'ski' finds the ski club, not 'skills'", () => {
  assert.deepEqual(findClubs(clubs, "ski").clubs.map((c) => c.name), ["Middlebury Ski & Ride Club"]);
});

test("real clubs rank above boards", () => {
  const names = findClubs(clubs, "performing arts").clubs.map((c) => c.name);
  assert.deepEqual(names, ["The Middlebury Bobolinks", "Performing Arts Organizations"].filter((n) => names.includes(n)));
  assert.equal(findClubs(clubs, "a cappella").clubs[0].name, "The Middlebury Bobolinks");
});

test("more placeholder meeting details count as not posted; real notes are kept", () => {
  const meets = (t) => normalizeClub({ name: "X", regularMeetingTime: t }).meets;
  for (const t of ["TBD", "To Be Determined", "TBD for Fall", "tba.", "N/A", ""]) assert.equal(meets(t), null, t);
  assert.equal(meets("Varies"), "Varies");
  assert.equal(meets("n/a (we don't have regularly scheduled open meetings)"), "n/a (we don't have regularly scheduled open meetings)");
});

test("joining is read from the club's own flags", () => {
  assert.match(joinInfo({ allowStudentsToJoinOnPortal: true, requireApprovalForMembers: true }).text, /officers approve/);
  assert.equal(joinInfo({ allowStudentsToJoinOnPortal: true, requireApprovalForMembers: false }).approval, false);
  assert.match(joinInfo({ allowStudentsToJoinOnPortal: false, hasEmailAddress: true }).text, /contact its leaders/);
  assert.equal(joinInfo({}), null);
});

const now = new Date("2026-09-22T16:00:00Z");
const presenceEvents = [
  { eventName: "Ski & Ride interest meeting", organizationName: "Middlebury Ski & Ride Club", organizationUri: "middlebury-ski-ride-club", uri: "ski-meeting", location: "Axinn 229", startDateTimeUtc: "2026-09-24T23:00:00Z", endDateTimeUtc: "2026-09-25T00:00:00Z" },
  { eventName: "Last week's meeting", organizationName: "Middlebury Ski & Ride Club", organizationUri: "middlebury-ski-ride-club", uri: "old", startDateTimeUtc: "2026-09-15T23:00:00Z", endDateTimeUtc: "2026-09-16T00:00:00Z" },
  { eventName: "Bobolinks concert", organizationName: "The Middlebury Bobolinks", organizationUri: "the-middlebury-bobolinks", uri: "concert", startDateTimeUtc: "2026-09-26T23:00:00Z", endDateTimeUtc: "2026-09-27T00:00:00Z" },
];

test("a specific club comes with its next events and how to join", async (t) => {
  clearClubsCache();
  clearEventsCache();
  const requested = stubFetch(t, {
    "organizations/middlebury-ski-ride-club": { body: { allowStudentsToJoinOnPortal: true, requireApprovalForMembers: true, hasEmailAddress: true, contactName: " Pat Example " } },
    "v1/organizations": { body: raw },
    "v1/events": { body: presenceEvents },
  });
  const result = await getClubs({ keyword: "ski" }, now);
  const [ski] = result.clubs;
  assert.equal(ski.upcoming.length, 1, "past events are left out");
  assert.equal(ski.upcoming[0].name, "Ski & Ride interest meeting");
  assert.equal(ski.join.approval, true);
  assert.equal(ski.contact, "Pat Example");
  assert.ok(requested.every((u, i) => requested.inits[i].headers["user-agent"]), "every request sends a User-Agent");
});

test("the model is told when nothing is posted, and the card gets the next event", async (t) => {
  clearClubsCache();
  clearEventsCache();
  stubFetch(t, {
    "organizations/club-tennis": { body: { allowStudentsToJoinOnPortal: true, requireApprovalForMembers: false } },
    "v1/organizations": { body: raw },
    "v1/events": { body: presenceEvents },
  });
  t.mock.timers.enable({ apis: ["Date"], now });
  const out = await clubsTool.run({ keyword: "tennis" });
  const club = JSON.parse(out.content).clubs[0];
  assert.equal(club.next_events, "none posted");
  assert.match(club.joining, /no approval needed/);
  assert.equal(out.card.clubs[0].next, null);
  assert.equal(club.contact, undefined, "no contact listed means none is mentioned");
});

test("a club search still answers when a club's own record can't be read", async (t) => {
  clearClubsCache();
  clearEventsCache();
  stubFetch(t, { "v1/organizations": { body: raw }, "v1/events": { status: 500, body: "down" } });
  const result = await getClubs({ keyword: "bobolinks" }, now);
  assert.equal(result.clubs[0].join, null);
  assert.equal(result.clubs[0].upcoming, null);
  assert.equal(result.clubs[0].meets, "Tuesdays 6pm");
});
