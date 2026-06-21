#!/usr/bin/env node
// scripts/fetch-version.js
// §6.1 Version watcher.
//
// Polls Mojang's official bedrock-samples repo's version.json (a tiny raw
// file) for the current Bedrock version, compares against
// data/last-known-version.json, and prints a JSON status line on stdout.
// Does not mutate state unless --update is passed.
//
// Why this source: the Bedrock Dedicated Server zip (the spec's original
// §5 data source) stopped shipping the vanilla resource pack as plain JSON
// around Bedrock 1.19 — the RP is now packed in undocumented `.brarchive`
// binary archives and is unusable without a reverse-engineered decoder.
// `Mojang/bedrock-samples` is published by Mojang themselves, updated within
// days of each Bedrock release, and contains the vanilla RP as plain JSON in
// `resource_pack/`. It is the closest available equivalent to the spec's
// intent ("pull directly from the official source each run") and avoids any
// third-party community mirror.

import { readJson, writeJson, log, DIRS } from "./lib.js";
import path from "node:path";

const VERSION_URL = "https://raw.githubusercontent.com/Mojang/bedrock-samples/main/version.json";
const LAST_PATH = path.join(DIRS.data, "last-known-version.json");

const args = process.argv.slice(2);
const UPDATE = args.includes("--update");
const VERBOSE = args.includes("--verbose") || process.env.MRP_VERBOSE;

async function fetchVersionJson() {
  const controller = new AbortController();
  const to = setTimeout(() => controller.abort(), 30000);
  try {
    const res = await fetch(VERSION_URL, { signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(to);
  }
}

async function main() {
  const last = readJson(LAST_PATH);
  let payload;
  try {
    payload = await fetchVersionJson();
  } catch (err) {
    log("version.json endpoint unavailable:", err.message);
    const status = { changed: false, version: last.version, error: String(err) };
    process.stdout.write(JSON.stringify(status) + "\n");
    process.exit(0);
  }
  if (VERBOSE) log("version.json payload:", JSON.stringify(payload).slice(0, 400));

  // Shape: { "latest": { "version": "1.26.30.5", "date": "16-06-2026" }, "<ver>": {...}, ... }
  const latest = payload.latest || {};
  const version = latest.version;
  if (!version) {
    log("could not find latest.version in payload");
    process.stdout.write(JSON.stringify({ changed: false, version: null, error: "no-version" }) + "\n");
    process.exit(0);
  }

  const changed = last.version !== version;
  const status = {
    changed,
    version,
    last_version: last.version,
    date: latest.date,
    repo: "Mojang/bedrock-samples",
    checked_at: new Date().toISOString(),
  };

  if (UPDATE && changed) {
    writeJson(LAST_PATH, { version, checked_at: status.checked_at });
    log(`updated last-known-version -> ${version}`);
  }
  process.stdout.write(JSON.stringify(status) + "\n");
}

main().catch((err) => {
  console.error("fetch-version fatal:", err);
  process.exit(1);
});