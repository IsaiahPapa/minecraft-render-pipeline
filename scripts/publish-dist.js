#!/usr/bin/env node
// scripts/publish-dist.js
// §9 dist/ publication. Mirrors output/ into dist/<version>/ (pinned per
// Bedrock version) and dist/latest/ (rolling snapshot of the most recent
// pipeline run).
//
// URL shape (consumers use jsDelivr to hotlink):
//   https://cdn.jsdelivr.net/gh/<user>/<repo>@bedrock-<version>/dist/<version>/<slug>/headshot.png
//   https://cdn.jsdelivr.net/gh/<user>/<repo>@main/dist/latest/<slug>/headshot.png
//
// Idempotent: skips writing when the target file already has identical bytes.

import fs from "node:fs";
import path from "node:path";
import { readJson, log, DIRS, ensureDir } from "./lib.js";

const VERSION_PATH = path.join(DIRS.data, "last-known-version.json");

function copyFile(src, dst) {
  if (!fs.existsSync(src)) return false;
  ensureDir(path.dirname(dst));
  // Skip write when bytes are identical.
  if (fs.existsSync(dst)) {
    const a = fs.readFileSync(src);
    const b = fs.readFileSync(dst);
    if (a.length === b.length && a.equals(b)) return false;
  }
  fs.copyFileSync(src, dst);
  return true;
}

function copyDir(src, dst, skipNames = new Set()) {
  let copied = 0;
  if (!fs.existsSync(src) || !fs.statSync(src).isDirectory()) return 0;
  ensureDir(dst);
  for (const entry of fs.readdirSync(src)) {
    if (skipNames.has(entry)) continue;
    const s = path.join(src, entry);
    const d = path.join(dst, entry);
    if (fs.statSync(s).isDirectory()) {
      copied += copyDir(s, d, skipNames);
    } else {
      if (copyFile(s, d)) copied++;
    }
  }
  return copied;
}

function publishTo(targetDir) {
  let count = 0;
  // Skip intermediate spin frame dirs (36 individual PNGs per mob); only
  // the final spin.webp and spin.gif are deliverables.
  const skipNames = new Set(["spin", ".DS_Store"]);
  // Copy each slug subdir.
  for (const slug of fs.readdirSync(DIRS.output)) {
    if (slug === "manifest.json" || slug === "contact-sheet.png" || slug.startsWith(".")) continue;
    const srcDir = path.join(DIRS.output, slug);
    if (!fs.statSync(srcDir).isDirectory()) continue;
    // Skip dirs that have no headshot and no spin (e.g. empty leftover dirs).
    const hasHeadshot = fs.existsSync(path.join(srcDir, "headshot.png"));
    const hasSpin = fs.existsSync(path.join(srcDir, "spin.webp")) || fs.existsSync(path.join(srcDir, "spin.gif"));
    if (!hasHeadshot && !hasSpin) continue;
    const n = copyDir(srcDir, path.join(targetDir, slug), skipNames);
    count += n;
  }
  // Copy manifest.json + contact-sheet.png.
  const manifestSrc = path.join(DIRS.output, "manifest.json");
  if (fs.existsSync(manifestSrc)) {
    if (copyFile(manifestSrc, path.join(targetDir, "manifest.json"))) count++;
  }
  const sheetSrc = path.join(DIRS.output, "contact-sheet.png");
  if (fs.existsSync(sheetSrc)) {
    if (copyFile(sheetSrc, path.join(targetDir, "contact-sheet.png"))) count++;
  }
  return count;
}

function main() {
  if (!fs.existsSync(DIRS.output) || !fs.existsSync(VERSION_PATH)) {
    log("publish-dist: no output/ or no version file; skipping");
    return;
  }
  const { version } = readJson(VERSION_PATH);
  if (!version) {
    log("publish-dist: no version in last-known-version.json; skipping");
    return;
  }

  const distRoot = path.join(DIRS.root, "dist");
  ensureDir(distRoot);

  // 1. Publish to dist/<version>/ (pinned per Bedrock version).
  const versionDir = path.join(distRoot, version);
  const n1 = publishTo(versionDir);
  log(`publish-dist: dist/${version}/ — ${n1} files written/updated`);

  // 2. Publish to dist/latest/ (rolling snapshot, clobbered every run).
  const latestDir = path.join(distRoot, "latest");
  const n2 = publishTo(latestDir);
  log(`publish-dist: dist/latest/ — ${n2} files written/updated`);
}

main();