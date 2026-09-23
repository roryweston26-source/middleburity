// Reading GTFS timetables (zip files of CSVs) with nothing but Node's own zlib. Shared by
// build-transit.js (Tri-Valley's local buses) and build-intercity.js (Amtrak, Vermont Translines).
import { inflateRawSync } from "node:zlib";
import { USER_AGENT } from "../src/user-agent.js";

// Reads the files out of a zip archive (stored or deflated entries, which is all GTFS uses).
export function unzip(buf, wanted) {
  let end = buf.length - 22;
  while (end >= 0 && buf.readUInt32LE(end) !== 0x06054b50) end--;
  if (end < 0) throw new Error("not a zip file");
  const count = buf.readUInt16LE(end + 10);
  let p = buf.readUInt32LE(end + 16);
  const files = {};
  for (let i = 0; i < count; i++) {
    const method = buf.readUInt16LE(p + 10);
    const size = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString("utf8", p + 46, p + 46 + nameLen);
    p += 46 + nameLen + extraLen + commentLen;
    if (!wanted.includes(name)) continue;
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const data = buf.subarray(start, start + size);
    files[name] = (method === 8 ? inflateRawSync(data) : data).toString("utf8");
  }
  return files;
}

// CSV with quoted fields (the feed's trip messages contain commas).
export function parseCsv(text) {
  const rows = [];
  let row = [], field = "", quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field); field = "";
      if (row.length > 1 || row[0] !== "") rows.push(row);
      row = [];
    } else field += c;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  const [head, ...body] = rows;
  const keys = head.map((h) => h.replace(/^﻿/, "").trim());
  return body.map((r) => Object.fromEntries(keys.map((k, i) => [k, (r[i] ?? "").trim()])));
}

export const isoDate = (d) => `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`;

// Downloads a feed and returns the named files as parsed rows (missing files come back empty).
export async function loadGtfs(url, names) {
  const res = await fetch(url, { headers: { "user-agent": USER_AGENT }, signal: AbortSignal.timeout(120000) });
  if (!res.ok) throw new Error(`${url} returned ${res.status}`);
  const files = unzip(Buffer.from(await res.arrayBuffer()), names);
  return Object.fromEntries(names.map((n) => [n.replace(/\.txt$/, ""), files[n] ? parseCsv(files[n]) : []]));
}
