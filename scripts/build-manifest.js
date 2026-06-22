#!/usr/bin/env node
// scripts/build-manifest.js
// §7 output structure. Builds output/manifest.json from the capture/postprocess results.

import fs from "node:fs";
import path from "node:path";
import { readJson, writeJson, log, DIRS, entitySlug } from "./lib.js";

const RUN_PLAN_PATH = path.join(DIRS.cache, "run-plan.json");
const OVERRIDES_PATH = path.join(DIRS.data, "overrides.json");

function parseArgs(argv) {
  const o = { version: null };
  for (let i = 0; i < argv.length; i++) if (argv[i] === "--version") o.version = argv[++i];
  return o;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const plan = fs.existsSync(RUN_PLAN_PATH) ? readJson(RUN_PLAN_PATH) : { to_render: [], overrides: {} };
  const overrides = fs.existsSync(OVERRIDES_PATH) ? readJson(OVERRIDES_PATH).overrides || {} : {};
  const extractedMeta = fs.existsSync(path.join(DIRS.cache, "extracted.json"))
    ? readJson(path.join(DIRS.cache, "extracted.json"))
    : { version: null };
  const version = opts.version || plan.version || extractedMeta.version || null;

  const slugToIdent = new Map();
  for (const ident of plan.to_render || []) {
    slugToIdent.set(entitySlug(ident), ident);
  }

  const entities = {};
  // Iterate over all rendered output directories.
  if (fs.existsSync(DIRS.output)) {
    for (const slug of fs.readdirSync(DIRS.output)) {
      if (slug === "manifest.json" || slug === "contact-sheet.png" || slug.startsWith(".")) continue;
      const dir = path.join(DIRS.output, slug);
      if (!fs.statSync(dir).isDirectory()) continue;
      // Skip dirs that have neither a headshot nor spin files.
      const hasHeadshot = fs.existsSync(path.join(dir, "headshot.png"));
      const hasSpin = fs.existsSync(path.join(dir, "spin.webp")) || fs.existsSync(path.join(dir, "spin.gif"));
      if (!hasHeadshot && !hasSpin) continue;
      const ident = slugToIdent.get(slug) || `minecraft:${slug}`;
      const displayName = ident.replace(/^minecraft:/, "").replace(/_/g, " ");
      const entry = { slug, identifier: ident, name: displayName };
      if (hasHeadshot) entry.headshot = `${slug}/headshot.png`;
      if (fs.existsSync(path.join(dir, "spin.webp"))) entry.spin_webp = `${slug}/spin.webp`;
      if (fs.existsSync(path.join(dir, "spin.gif"))) entry.spin_gif = `${slug}/spin.gif`;
      entry.source = overrides[ident] ? "manual" : "bedrock";
      entry.needs_review = !!(overrides[ident] && overrides[ident].needs_review);
      entities[ident] = entry;
    }
  }
  // Add overrides that have no automated render.
  for (const ident of Object.keys(overrides)) {
    if (!entities[ident]) {
      const slug = entitySlug(ident);
      const dir = path.join(DIRS.output, slug);
      const entry = { source: "manual", needs_review: !overrides[ident]?.needs_review === false ? true : overrides[ident].needs_review };
      if (fs.existsSync(path.join(dir, "headshot.png"))) entry.headshot = `${slug}/headshot.png`;
      if (fs.existsSync(path.join(dir, "spin.webp"))) entry.spin_webp = `${slug}/spin.webp`;
      if (fs.existsSync(path.join(dir, "spin.gif"))) entry.spin_gif = `${slug}/spin.gif`;
      entities[ident] = entry;
    }
  }

  const manifest = {
    schema: {
      description: "Index of all rendered Minecraft Bedrock mob assets. Each entity has relative paths to its headshot (transparent PNG, 512x512) and spin animation (animated WebP with full alpha, 256x256, 36 frames at 12fps). Paths are relative to this manifest's directory. For CDN URLs, prefix with https://cdn.jsdelivr.net/gh/<user>/<repo>@<tag>/dist/<version>/",
      fields: {
        slug: "URL-safe slug (minecraft:cow -> cow)",
        identifier: "Full Minecraft entity identifier (minecraft:cow)",
        name: "Human-readable display name",
        headshot: "Relative path to 512x512 transparent PNG headshot",
        spin_webp: "Relative path to animated WebP spin (256x256, full alpha)",
        spin_gif: "Relative path to animated GIF spin (256x256, 1-bit alpha legacy)",
        source: "bedrock = auto-rendered from Bedrock data, manual = hand-produced override",
        needs_review: "True if the render may need manual review",
      },
    },
    minecraft_version: version,
    generated_at: new Date().toISOString(),
    entity_count: Object.keys(entities).length,
    entities,
  };
  writeJson(path.join(DIRS.output, "manifest.json"), manifest);
  log(`manifest written: ${Object.keys(entities).length} entities`);
}

main().catch((err) => {
  console.error("build-manifest fatal:", err);
  process.exit(1);
});