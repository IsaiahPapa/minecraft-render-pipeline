#!/usr/bin/env node
// postprocess/encode-spin.js
// §6.7 Spin animation encoder.
//
// Encodes the per-frame PNGs in output/<slug>/spin/ into:
//   - output/<slug>/spin.gif    (animated GIF via ffmpeg, proper frame disposal)
//   - output/<slug>/spin.webp   (animated WebP via cwebp+webpmux, full 8-bit alpha)
//
// Both encoders preserve transparency. The GIF uses ffmpeg's paletteuse
// with diff_mode=rectangle and alpha_threshold to ensure each frame clears
// the previous one (no ghosting/trailing). The WebP is lossless with full
// alpha from the PNG source frames.

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

function encodeGIF(frameDir, outPath, fps, w, h) {
  // Two-step: ffmpeg encodes the GIF with palette optimization, then gifsicle
  // post-processes it to set disposal=bg (restore to background) on every frame.
  // This combination ensures frames are properly cleared between animation
  // steps, preventing the "ghosting"/"overlay" effect where frames stack on
  // top of each other.
  const inputPattern = path.join(frameDir, "%03d.png");
  const rawGif = outPath + ".raw.gif";
  execFileSync("ffmpeg", [
    "-y", "-framerate", String(fps),
    "-i", inputPattern,
    "-vf", `scale=${w}:${h}:flags=neighbor,split[s0][s1];[s0]palettegen=max_colors=128:reserve_transparent=1:transparency_color=0x000000[p];[s1][p]paletteuse=dither=none:alpha_threshold=128`,
    "-loop", "0",
    "-plays", "0",
    rawGif,
  ], { stdio: ["pipe", "pipe", "pipe"] });
  // Post-process with gifsicle to set disposal=bg on all frames.
  execFileSync("gifsicle", [
    "--disposal=bg",
    "--loop=0",
    `--delay=${Math.round(100 / fps)}`,
    rawGif,
    "-o", outPath,
  ], { stdio: ["pipe", "pipe", "pipe"] });
  fs.rmSync(rawGif, { force: true });
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
    execFileSync("cwebp", ["-lossless", "-quiet", framePaths[i], "-o", frameWebP]);
    webpFrames.push(frameWebP);
  }
  const muxArgs = [];
  for (let i = 0; i < webpFrames.length; i++) {
    muxArgs.push("-frame", webpFrames[i], `+${delay}`);
  }
  muxArgs.push("-loop", "0", "-o", outPath);
  execFileSync("webpmux", muxArgs);
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

async function processSlug(slug, sharp, fps) {
  const spinDir = path.join(OUTPUT_DIR, slug, "spin");
  if (!fs.existsSync(spinDir)) return false;
  const frameFiles = fs.readdirSync(spinDir).filter((f) => f.endsWith(".png")).sort();
  if (!frameFiles.length) return false;
  const framePaths = frameFiles.map((f) => path.join(spinDir, f));
  const firstMeta = await sharp(framePaths[0]).metadata();
  const w = firstMeta.width;
  const h = firstMeta.height;

  // Encode GIF (ffmpeg, proper disposal + transparency).
  const gifPath = path.join(OUTPUT_DIR, slug, "spin.gif");
  encodeGIF(spinDir, gifPath, fps, w, h);

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
      await processSlug(slug, sharp, opts.fps);
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