#!/usr/bin/env node
// postprocess/encode-spin.js
// §6.7 Spin animation encoder.
//
// Encodes the per-frame PNGs in output/<slug>/spin/ into:
//   - output/<slug>/spin.gif    (animated GIF, 1-bit alpha — legacy/compat)
//   - output/<slug>/spin.webp   (animated WebP, full 8-bit alpha via cwebp+webpmux)
//
// The WebP is encoded directly from the PNG frames using cwebp (lossless)
// and muxed into an animation with webpmux. This preserves full alpha
// transparency, unlike the previous approach of transcoding from GIF
// (which flattened onto black and lost alpha).
//
// The GIF is a legacy export with 1-bit alpha (jagged silhouette edges).
// This tradeoff is documented in the README.

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { readJson, log, DIRS, entitySlug, ensureDir } from "../scripts/lib.js";

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
    // cleanly. The WebP is encoded separately from PNG frames (not from
    // this GIF) to preserve full 8-bit alpha.
    // IMPORTANT: gif-encoder-2's analyzePixels assumes 4-channel RGBA input.
    // .ensureAlpha() forces 4-channel output so the encoder reads the right
    // bytes (see AGENTS.md for the bug history).
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

function encodeAnimatedWebP(framePaths, outPath, fps) {
  // Encode each PNG frame as a lossless WebP with full alpha, then mux
  // them into an animated WebP using webpmux.
  const tmpDir = path.join(path.dirname(outPath), ".webp-tmp");
  ensureDir(tmpDir);
  const delay = Math.round(1000 / fps);
  const webpFrames = [];
  for (let i = 0; i < framePaths.length; i++) {
    const frameWebP = path.join(tmpDir, `f${String(i).padStart(4, "0")}.webp`);
    execFileSync("cwebp", [
      "-lossless",
      "-quiet",
      framePaths[i],
      "-o",
      frameWebP,
    ]);
    webpFrames.push(frameWebP);
  }
  // Build webpmux args: -frame <file> +<delay> -loop 0 -o <output>
  const muxArgs = [];
  for (let i = 0; i < webpFrames.length; i++) {
    muxArgs.push("-frame", webpFrames[i], `+${delay}`);
  }
  muxArgs.push("-loop", "0", "-o", outPath);
  execFileSync("webpmux", muxArgs);
  // Clean up temp frames
  fs.rmSync(tmpDir, { recursive: true, force: true });
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

  // Encode GIF (legacy, 1-bit alpha).
  const gifPath = path.join(OUTPUT_DIR, slug, "spin.gif");
  await encodeGIF(sharp, GIFEncoder, framePaths, gifPath, fps, w, h);

  // Encode animated WebP (full alpha via cwebp + webpmux).
  const webpPath = path.join(OUTPUT_DIR, slug, "spin.webp");
  encodeAnimatedWebP(framePaths, webpPath, fps);

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