#!/usr/bin/env node
// postprocess/trim-and-pad.js
// §6.8 Post-processing.
//
// For each captured entity in cache/frames/<slug>/:
//   headshot.png        -> output/<slug>/headshot.png  (trim to bbox, pad to square)
//   spin/000.png...N    -> output/<slug>/spin/000.png  (each frame trimmed+padded
//                                                      to the same square using a
//                                                      union bounding box, so the
//                                                      spin doesn't jitter)
//
// Full alpha must be preserved end-to-end. We use `sharp` and explicitly set
// extend fill to {r:0,g:0,b:0,alpha:0}. Do NOT use .flatten().

import fs from "node:fs";
import path from "node:path";
import { readJson, log, DIRS, entitySlug } from "../scripts/lib.js";

const FRAMES_DIR = path.join(DIRS.cache, "frames");
const OUTPUT_DIR = path.join(DIRS.output);
const HEADSHOT_SIZE = 512;
const SPIN_SIZE = 256;

function parseArgs(argv) {
  const o = { entity: null };
  for (let i = 0; i < argv.length; i++) if (argv[i] === "--entity") o.entity = argv[++i];
  return o;
}

// Returns the alpha-channel bounding box of an image, or null if fully
// transparent.
async function alphaBBox(sharpImg) {
  const { data, info } = await sharpImg.raw().ensureAlpha().toBuffer({ resolveWithObject: true });
  const channels = info.channels; // 4 after ensureAlpha
  let minX = info.width, minY = info.height, maxX = -1, maxY = -1;
  for (let y = 0; y < info.height; y++) {
    for (let x = 0; x < info.width; x++) {
      const a = data[(y * info.width + x) * channels + channels - 1];
      if (a > 0) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < 0) return null;
  return { left: minX, top: minY, width: maxX - minX + 1, height: maxY - minY + 1 };
}

async function processHeadshot(slug, sharp) {
  const src = path.join(FRAMES_DIR, slug, "headshot.png");
  if (!fs.existsSync(src)) return false;
  const bbox = await alphaBBox(sharp(src).clone());
  if (!bbox) return false;
  const canvas = HEADSHOT_SIZE;
  const scale = Math.min(canvas / bbox.width, canvas / bbox.height, 1);
  const scaledW = Math.max(1, Math.round(bbox.width * scale));
  const scaledH = Math.max(1, Math.round(bbox.height * scale));
  const left = Math.floor((canvas - scaledW) / 2);
  const top = Math.floor((canvas - scaledH) / 2);
  const target = path.join(OUTPUT_DIR, slug, "headshot.png");
  fs.mkdirSync(path.dirname(target), { recursive: true });
  await sharp(src)
    .extract({ left: bbox.left, top: bbox.top, width: bbox.width, height: bbox.height })
    .resize(scaledW, scaledH, { fit: "fill" })
    .extend({
      top,
      bottom: canvas - scaledH - top,
      left,
      right: canvas - scaledW - left,
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    })
    .png({ compressionLevel: 9 })
    .toFile(target);
  return true;
}

async function processSpin(slug, sharp) {
  const spinDir = path.join(FRAMES_DIR, slug, "spin");
  if (!fs.existsSync(spinDir)) return false;
  const frameFiles = fs.readdirSync(spinDir).filter((f) => f.endsWith(".png")).sort();
  if (!frameFiles.length) return false;

  // Union bbox across all frames -> stable framing for the whole spin.
  let union = { left: Infinity, top: Infinity, right: -Infinity, bottom: -Infinity };
  for (const f of frameFiles) {
    const bbox = await alphaBBox(sharp(path.join(spinDir, f)).clone());
    if (!bbox) continue;
    const right = bbox.left + bbox.width;
    const bottom = bbox.top + bbox.height;
    if (bbox.left < union.left) union.left = bbox.left;
    if (bbox.top < union.top) union.top = bbox.top;
    if (right > union.right) union.right = right;
    if (bottom > union.bottom) union.bottom = bottom;
  }
  if (union.right < 0) return false;
  const unionW = union.right - union.left;
  const unionH = union.bottom - union.top;

  const canvas = SPIN_SIZE;
  const scale = Math.min(canvas / unionW, canvas / unionH, 1);
  const scaledW = Math.max(1, Math.round(unionW * scale));
  const scaledH = Math.max(1, Math.round(unionH * scale));
  const left = Math.floor((canvas - scaledW) / 2);
  const top = Math.floor((canvas - scaledH) / 2);

  const outDir = path.join(OUTPUT_DIR, slug, "spin");
  fs.mkdirSync(outDir, { recursive: true });

  for (let i = 0; i < frameFiles.length; i++) {
    const src = path.join(spinDir, frameFiles[i]);
    const meta = await sharp(src).metadata();
    const exLeft = Math.max(0, Math.min(union.left, meta.width - 1));
    const exTop = Math.max(0, Math.min(union.top, meta.height - 1));
    const exRight = Math.min(meta.width, union.right);
    const exBottom = Math.min(meta.height, union.bottom);
    const exW = Math.max(1, exRight - exLeft);
    const exH = Math.max(1, exBottom - exTop);
    await sharp(src)
      .extract({ left: exLeft, top: exTop, width: exW, height: exH })
      .resize(scaledW, scaledH, { fit: "fill" })
      .extend({
        top,
        bottom: canvas - scaledH - top,
        left,
        right: canvas - scaledW - left,
        background: { r: 0, g: 0, b: 0, alpha: 0 },
      })
      .png({ compressionLevel: 9 })
      .toFile(path.join(outDir, `${String(i).padStart(3, "0")}.png`));
  }
  return true;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const sharp = (await import("sharp")).default;
  let slugs;
  if (opts.entity) {
    slugs = [entitySlug(opts.entity)];
  } else {
    const cap = readJson(path.join(DIRS.cache, "capture.json"));
    slugs = cap.results.map((r) => r.slug);
  }
  let ok = 0;
  let fail = 0;
  for (const slug of slugs) {
    try {
      const head = await processHeadshot(slug, sharp);
      const spin = await processSpin(slug, sharp);
      log(`[${slug}] postprocess head=${head} spin=${spin}`);
      ok++;
    } catch (err) {
      log(`[${slug}] postprocess FAILED: ${err.message}`);
      fail++;
    }
  }
  log(`postprocess done: ok=${ok} fail=${fail}`);
}

main().catch((err) => {
  console.error("trim-and-pad fatal:", err);
  process.exit(1);
});