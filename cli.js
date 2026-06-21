#!/usr/bin/env node
// cli.js — top-level orchestrator for the mob render pipeline.
//
// Runs the phases in order per the spec's §10 phased plan, with the
// incremental (diff-based) optimization already wired in (phase-5 items).
//
// Usage:
//   node cli.js                       # full incremental run
//   node cli.js --force-all           # re-render every entity
//   node cli.js --entity minecraft:cow --skip-spin   # dev smoke test
//   MRP_SKIP_DOWNLOAD=1 node cli.js   # reuse cache/extracted
//
// Phases:
//   1. fetch-version   (only when not --entity)
//   2. extract-pack    (skip if version unchanged AND not --force-all AND not --entity)
//   3. diff-entities   (build run-plan)
//   4. parse-geometry
//   5. capture
//   6. postprocess (trim-and-pad)
//   7. encode-spin
//   8. build-manifest
//   9. (optional) commit handled by CI workflow, not here.

import { spawn } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import { log, DIRS } from "./scripts/lib.js";

function parseArgs(argv) {
  const o = { forceAll: false, entity: null, skipSpin: false, frames: 36, width: 1024, height: 1024 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--force-all") o.forceAll = true;
    else if (a === "--entity") o.entity = argv[++i];
    else if (a === "--skip-spin") o.skipSpin = true;
    else if (a === "--frames") o.frames = parseInt(argv[++i], 10);
    else if (a === "--width") o.width = parseInt(argv[++i], 10);
    else if (a === "--height") o.height = parseInt(argv[++i], 10);
  }
  if (process.env.MRP_SKIP_SPIN === "1") o.skipSpin = true;
  return o;
}

function run(cmd, args, _opts = {}) {
  log(`$ ${cmd} ${args.join(" ")}`);
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      stdio: ["ignore", "pipe", "inherit"],
      cwd: DIRS.root,
      env: { ...process.env, NODE_PATH: path.join(DIRS.root, "node_modules") },
    });
    let stdout = "";
    child.stdout.on("data", (d) => {
      stdout += d.toString();
      process.stdout.write(d);
    });
    child.on("error", reject);
    child.on("close", (code) => (code === 0 ? resolve(stdout) : reject(new Error(`${cmd} exit ${code}`))));
  });
}

function runScript(relPath, extraArgs = []) {
  return run(process.execPath, [path.join(DIRS.root, relPath), ...extraArgs]);
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  log(`pipeline start${opts.entity ? ` (single entity: ${opts.entity})` : ""}${opts.forceAll ? " (force-all)" : ""}`);

  // 1. Version check (skip for single-entity dev mode).
  let versionStatus = null;
  if (!opts.entity) {
    const out = await runScript("scripts/fetch-version.js", ["--update", "--verbose"]);
    const line = out.split("\n").find((l) => l.trim().startsWith("{"));
    versionStatus = line ? JSON.parse(line) : {};
    log(`version: current=${versionStatus.version} last=${versionStatus.last_version} changed=${versionStatus.changed}`);
    // If nothing changed and not forcing all, exit early — idempotent no-op.
    if (!versionStatus.changed && !opts.forceAll && fs.existsSync(path.join(DIRS.output, "manifest.json"))) {
      log("no version change and not --force-all; pipeline is a no-op (idempotent)");
      return;
    }
  }

  // 2. Extract pack.
  if (!opts.entity || !fs.existsSync(path.join(DIRS.cache, "extracted", "vanilla"))) {
    await runScript("scripts/extract-pack.js");
  } else {
    log("single-entity mode and extracted pack present; skipping extract");
  }

  // 3. Diff entities.
  const diffArgs = ["--update"];
  if (opts.forceAll) diffArgs.push("--force-all");
  if (opts.entity) diffArgs.push("--entity", opts.entity);
  await runScript("scripts/diff-entities.js", diffArgs);

  // 4. Parse geometry.
  const geomArgs = [];
  if (opts.entity) geomArgs.push("--entity", opts.entity);
  await runScript("scripts/parse-geometry.js", geomArgs);

  // 5. Capture.
  const captureArgs = ["--frames", String(opts.frames), "--width", String(opts.width), "--height", String(opts.height)];
  if (opts.entity) captureArgs.push("--entity", opts.entity);
  if (opts.skipSpin) captureArgs.push("--skip-spin");
  await runScript("render/capture.js", captureArgs);

  // 6. Postprocess.
  const ppArgs = [];
  if (opts.entity) ppArgs.push("--entity", opts.entity);
  await runScript("postprocess/trim-and-pad.js", ppArgs);

  // 7. Encode spin.
  if (!opts.skipSpin) {
    const encArgs = [];
    if (opts.entity) encArgs.push("--entity", opts.entity);
    await runScript("postprocess/encode-spin.js", encArgs);
  } else {
    log("skipping spin encode (--skip-spin)");
  }

  // 8. Build manifest.
  const manifestArgs = [];
  if (versionStatus?.version) manifestArgs.push("--version", versionStatus.version);
  await runScript("scripts/build-manifest.js", manifestArgs);

  // 9. Publish to dist/<version>/ + dist/latest/ for jsDelivr hotlinking.
  await runScript("scripts/publish-dist.js");

  log("pipeline complete");
}

main().catch((err) => {
  console.error("pipeline fatal:", err);
  process.exit(1);
});