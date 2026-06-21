#!/usr/bin/env node
// postprocess/encode-spin.js
// §6.7 Spin animation encoder.
//
// Encodes the per-frame PNGs in output/<slug>/spin/ into:
//   - output/<slug>/spin.gif    (animated GIF, 1-bit alpha — legacy/compat)
//   - output/<slug>/spin.webp   (animated WebP, transcoded from the GIF)
//
// Why GIF-first: sharp can read an animated GIF and transcode to animated
// WebP, but cannot directly build an animated WebP from a stack of PNG
// frames without an intermediate animated input. So we encode the GIF
// first (gif-encoder-2) and transcode it to WebP (sharp).
//
// Per spec §6.7 the GIF tradeoff (1-bit alpha -> jagged silhouette edges) is
// documented in the README, not silent. The WebP inherits the GIF's 1-bit
// alpha as a known limitation of v1 — future work could use a real animated
// WebP encoder (e.g. webpmux / cwebp) to preserve 8-bit alpha from the PNG
// frames directly.

import fs from "node:fs";
import path from "node:path";
import { readJson, log, DIRS, entitySlug } from "../scripts/lib.js";

const OUTPUT_DIR = path.join(DIRS.output);

function parseArgs(argv) {
  const o = { entity: null, fps: 12 };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--entity") o.entity = argv[++i];
    else if (argv[i] === "--fps") o.fps = parseFloat(argv[++i]);
  }
  return o;
}

async function encodeGIF(sharp, GIFEncoder, framePaths, outPath, fps, w, h) {
  const encoder = new GIFEncoder(w, h);
  encoder.setQuality(10);
  encoder.setDelay(Math.round(1000 / fps));
  encoder.setRepeat(0); // 0 = loop forever
  encoder.setThreshold(20);
  const stream = fs.createWriteStream(outPath);
  encoder.pipe?.(stream) || encoder.createReadStream().pipe(stream);
  encoder.start();
  for (const p of framePaths) {
    // GIF has 1-bit alpha; flatten onto black so the silhouette binarizes
    // cleanly. The WebP (transcoded from this GIF) inherits this limitation.
    // IMPORTANT: gif-encoder-2's analyzePixels assumes 4-channel RGBA input
    // (it reads data[b], data[b+1], data[b+2] and skips data[b+3]). sharp's
    // .flatten() alone produces 3-channel RGB, which misaligns every pixel
    // and scrambles colors into "matrix/scan-line" artifacts. .ensureAlpha()
    // forces a 4-channel output so the encoder reads the right bytes.
    const { data } = await sharp(p)
      .resize(w, h, { fit: "fill" })
      .flatten({ background: { r: 0, g: 0, b: 0, alpha: 1 } })
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    encoder.addFrame(data);
  }
  encoder.finish();
  await new Promise((r) => stream.on("close", r));
}

async function encodeWebPFromGIF(sharp, gifPath, outPath) {
  await sharp(gifPath, { animated: true })
    .webp({ quality: 100, lossless: true, effort: 4 })
    .toFile(outPath);
}

async function processSlug(slug, sharp, GIFEncoder, fps) {
  const spinDir = path.join(OUTPUT_DIR, slug, "spin");
  if (!fs.existsSync(spinDir)) return false;
  const frameFiles = fs.readdirSync(spinDir).filter((f) => f.endsWith(".png")).sort();
  if (!frameFiles.length) return false;
  const framePaths = frameFiles.map((f) => path.join(spinDir, f));
  const firstMeta = await sharp(framePaths[0]).metadata();
  const w = firstMeta.width;
  const h = firstMeta.height;

  const gifPath = path.join(OUTPUT_DIR, slug, "spin.gif");
  await encodeGIF(sharp, GIFEncoder, framePaths, gifPath, fps, w, h);
  const webpPath = path.join(OUTPUT_DIR, slug, "spin.webp");
  await encodeWebPFromGIF(sharp, gifPath, webpPath);
  // Frames are now embedded in the animations; remove to keep output clean.
  fs.rmSync(spinDir, { recursive: true, force: true });
  return true;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const sharp = (await import("sharp")).default;
  const { default: GIFEncoder } = await import("gif-encoder-2");
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
      await processSlug(slug, sharp, GIFEncoder, opts.fps);
      log(`[${slug}] spin encoded`);
      ok++;
    } catch (err) {
      log(`[${slug}] encode FAILED: ${err.message}`);
      fail++;
    }
  }
  log(`encode-spin done: ok=${ok} fail=${fail}`);
}

main().catch((err) => {
  console.error("encode-spin fatal:", err);
  process.exit(1);
});