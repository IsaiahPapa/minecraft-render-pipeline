#!/usr/bin/env node
// scripts/diff-entities.js
// §6.3 Entity diff / manifest builder.
//
// Walks cache/extracted/vanilla/entity/*.entity.json, collects every
// minecraft:client_entity.description.identifier, and diffs against
// data/last-known-entities.json. Emits three buckets:
//   new / removed / unchanged
// and writes a run plan to cache/run-plan.json for the orchestrator.
//
// Flags:
//   --force-all       re-render everything (still writes the entity list)
//   --update          persist the new entity list to last-known-entities.json
//   --entity <id>     restrict to a single identifier (development)

import fs from "node:fs";
import path from "node:path";
import { readJson, writeJson, log, DIRS } from "./lib.js";

const RP = path.join(DIRS.extracted, "resource_pack");
const ENTITY_DIR = path.join(RP, "entity");
const LAST_PATH = path.join(DIRS.data, "last-known-entities.json");
const RUN_PLAN_PATH = path.join(DIRS.cache, "run-plan.json");
const OVERRIDES_PATH = path.join(DIRS.data, "overrides.json");

function parseArgs(argv) {
  const o = { forceAll: false, update: false, entity: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--force-all") o.forceAll = true;
    else if (argv[i] === "--update") o.update = true;
    else if (argv[i] === "--entity") o.entity = argv[++i];
  }
  return o;
}

function listEntityFiles() {
  if (!fs.existsSync(ENTITY_DIR)) return [];
  return fs
    .readdirSync(ENTITY_DIR)
    .filter((f) => f.endsWith(".json") || f.endsWith(".entity.json"))
    .map((f) => path.join(ENTITY_DIR, f));
}

function collectEntities() {
  const set = new Set();
  const fileOf = new Map();
  for (const f of listEntityFiles()) {
    let doc;
    try {
      doc = readJson(f);
    } catch (e) {
      log(`skipping unparseable ${path.basename(f)}: ${e.message}`);
      continue;
    }
    // File format: { "minecraft:foo": { "description": { "identifier": ..., ... } } }
    // OR an array of such. Be permissive.
    const entries = Array.isArray(doc) ? doc : [doc];
    for (const entry of entries) {
      if (!entry || typeof entry !== "object") continue;
      for (const key of Object.keys(entry)) {
        const def = entry[key];
        if (!def || typeof def !== "object") continue;
        const desc = def.description || def.client_entity?.description;
        const ident = desc?.identifier || key;
        if (ident && /^minecraft:/.test(ident)) {
          set.add(ident);
          fileOf.set(ident, path.relative(RP, f));
        }
      }
    }
  }
  return { list: [...set].sort(), fileOf };
}

function loadOverrides() {
  try {
    const o = readJson(OVERRIDES_PATH);
    return o.overrides || {};
  } catch {
    return {};
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (!fs.existsSync(RP)) {
    throw new Error(`vanilla pack not found at ${RP}; run extract-pack first`);
  }

  const { list, fileOf } = collectEntities();
  log(`collected ${list.length} entity identifiers from vanilla pack`);

  const last = readJson(LAST_PATH);
  const prev = new Set(last.entities || []);
  const overrides = loadOverrides();

  const newEntities = list.filter((id) => !prev.has(id));
  const removed = [...prev].filter((id) => !list.includes(id));
  const unchanged = list.filter((id) => prev.has(id));

  // Decide what to render.
  let toRender = args.forceAll
    ? [...list]
    : args.entity
      ? list.filter((id) => id === args.entity)
      : [...newEntities];

  // Manual overrides are always present in the manifest but never auto-rendered.
  for (const id of Object.keys(overrides)) {
    if (!list.includes(id)) {
      // Java-exclusive: not in Bedrock pack. Surface as "removed-from-bedrock"
      // but flagged for manual path. Do not add to `toRender`.
      removed.push(id);
    }
  }

  const plan = {
    version: readJson(path.join(DIRS.cache, "extracted.json"))?.version || null,
    generated_at: new Date().toISOString(),
    force_all: args.forceAll,
    requested_entity: args.entity,
    counts: {
      new: newEntities.length,
      removed: removed.length,
      unchanged: unchanged.length,
      to_render: toRender.length,
    },
    new: newEntities,
    removed,
    unchanged,
    to_render: toRender,
    entity_files: Object.fromEntries(fileOf),
    overrides,
  };

  writeJson(RUN_PLAN_PATH, plan);

  if (args.update) {
    writeJson(LAST_PATH, { version: plan.version, entities: list });
    log(`updated last-known-entities.json (${list.length} entities)`);
  }

  log(
    `diff: new=${newEntities.length} removed=${removed.length} unchanged=${unchanged.length} to_render=${toRender.length}`,
  );
  process.stdout.write(JSON.stringify(plan.counts) + "\n");
}

main().catch((err) => {
  console.error("diff-entities fatal:", err);
  process.exit(1);
});