import assert from "node:assert/strict";
import { test } from "node:test";
import { findClubs, normalizeClub } from "../src/tools/clubs.js";

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
