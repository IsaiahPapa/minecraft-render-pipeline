// Tiny shared helpers used across scripts. Pure Node ESM, no deps.

import fs from "node:fs";
import path from "node:path";

export const ROOT = path.resolve(new URL("..", import.meta.url).pathname);

export const DIRS = {
  root: ROOT,
  scripts: path.join(ROOT, "scripts"),
  render: path.join(ROOT, "render"),
  postprocess: path.join(ROOT, "postprocess"),
  data: path.join(ROOT, "data"),
  output: path.join(ROOT, "output"),
  cache: path.join(ROOT, "cache"),
  extracted: path.join(ROOT, "cache", "extracted"),
};

export function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

export function readJson(p) {
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

export function writeJson(p, obj, indent = 2) {
  ensureDir(path.dirname(p));
  fs.writeFileSync(p, JSON.stringify(obj, null, indent) + "\n");
}

// Stable slug: minecraft:warden -> warden ; minecraft:foo:bar -> foo_bar
export function entitySlug(identifier) {
  if (!identifier) return identifier;
  return identifier.replace(/^minecraft:/, "").replace(/:/g, "_");
}

export function log(...args) {
  console.log(new Date().toISOString().slice(11, 19), ...args);
}