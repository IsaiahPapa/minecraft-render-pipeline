#!/usr/bin/env node
// render/capture.js
// §6.5 + §6.6 Render harness + Capture driver.
//
// Starts a tiny local HTTP server (avoids file:// CORS issues with ES module
// imports and texture loads) that serves:
//   /harness.html   — the harness with three.js inlined
//   /<repo-rel-path>— any file under the repo root (used for textures in
//                     cache/extracted/resource_pack/textures/...)
//
// Then drives Puppeteer to load the harness, feed it each entity's normalized
// mesh JSON, and capture:
//   - one headshot.png (azimuth 30°, elevation 30°)
//   - N spin frames at evenly-spaced azimuths (default 36, 10° each)
//
// Transparency requirements (spec §6.6):
//   - capture as PNG, never JPEG
//   - page.screenshot({ omitBackground: true })
//   - html/body have no background color (verified in harness.html)
//   - after capture, verify corner alpha == 0; fail loudly if not
//
// Usage:
//   node render/capture.js                          // capture everything in run-plan.to_render
//   node render/capture.js --entity minecraft:cow
//   node render/capture.js --frames 36              // spin frame count (default 36)
//   node render/capture.js --width 1024 --height 1024
//   node render/capture.js --skip-spin             // headshot only

import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { readJson, writeJson, log, DIRS, entitySlug } from "../scripts/lib.js";

const HARNESS_PATH = path.join(DIRS.render, "harness.html");
const THREE_PATH = path.join(DIRS.root, "node_modules", "three", "build", "three.module.js");

const MESH_DIR = path.join(DIRS.cache, "meshes");
const FRAMES_DIR = path.join(DIRS.cache, "frames");
const RUN_PLAN_PATH = path.join(DIRS.cache, "run-plan.json");

function parseArgs(argv) {
  const o = { entity: null, frames: 36, width: 1024, height: 1024, skipSpin: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--entity") o.entity = argv[++i];
    else if (argv[i] === "--frames") o.frames = parseInt(argv[++i], 10);
    else if (argv[i] === "--width") o.width = parseInt(argv[++i], 10);
    else if (argv[i] === "--height") o.height = parseInt(argv[++i], 10);
    else if (argv[i] === "--skip-spin") o.skipSpin = true;
  }
  if (process.env.MRP_SKIP_SPIN === "1") o.skipSpin = true;
  return o;
}

// Tiny static file server. Serves:
//   /harness.html     -> render/harness.html
//   /three.module.js  -> node_modules/three/build/three.module.js
//   /<repo-rel-path>  -> any file under the repo root (used for textures in
//                       cache/extracted/resource_pack/textures/...)
function startServer(rootDir) {
  const MIME = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".png": "image/png",
    ".webp": "image/webp",
    ".gif": "image/gif",
    ".css": "text/css; charset=utf-8",
  };
  const sendFile = (res, abs) => {
    const ext = path.extname(abs).toLowerCase();
    res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream" });
    fs.createReadStream(abs).pipe(res);
  };
  const server = http.createServer((req, res) => {
    try {
      const urlPath = decodeURIComponent(req.url.split("?")[0]);
      if (urlPath === "/" || urlPath === "/harness.html") {
        sendFile(res, HARNESS_PATH);
        return;
      }
      if (urlPath === "/three.module.js") {
        sendFile(res, THREE_PATH);
        return;
      }
      const rel = urlPath.replace(/^\.?\//, "");
      const abs = path.resolve(path.join(rootDir, rel));
      if (!abs.startsWith(rootDir) || !fs.existsSync(abs) || fs.statSync(abs).isDirectory()) {
        res.writeHead(404);
        res.end("not found");
        return;
      }
      sendFile(res, abs);
    } catch (err) {
      res.writeHead(500);
      res.end(String(err));
    }
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({ server, port, base: `http://127.0.0.1:${port}` });
    });
  });
}

async function assertCornersTransparent(pngPath) {
  const sharp = (await import("sharp")).default;
  const meta = await sharp(pngPath).metadata();
  if (!meta.hasAlpha) {
    throw new Error(`${pngPath}: PNG has no alpha channel`);
  }
  const { data, info } = await sharp(pngPath).raw().toBuffer({ resolveWithObject: true });
  const channels = info.channels;
  const isTransparent = (x, y) => data[(y * info.width + x) * channels + channels - 1] === 0;
  const corners = [
    [0, 0],
    [info.width - 1, 0],
    [0, info.height - 1],
    [info.width - 1, info.height - 1],
  ];
  for (const [x, y] of corners) {
    if (!isTransparent(x, y)) {
      throw new Error(`${pngPath}: corner (${x},${y}) alpha != 0; transparency check failed`);
    }
  }
}

async function captureOne(browser, mesh, opts, textureBaseUrl) {
  const slug = mesh.slug;
  const outDir = path.join(FRAMES_DIR, slug);
  fs.mkdirSync(outDir, { recursive: true });
  fs.mkdirSync(path.join(outDir, "spin"), { recursive: true });

  const page = await browser.newPage();
  await page.setViewport({ width: opts.width, height: opts.height });
  await page.evaluateOnNewDocument(() => {
    // Inject a transparent background style as early as possible. At this
    // point document.head may not exist yet; guard against null.
    const inject = () => {
      const style = document.createElement("style");
      style.textContent = "html, body { background: transparent !important; }";
      (document.head || document.documentElement).appendChild(style);
    };
    if (document.head || document.documentElement) inject();
    else document.addEventListener("DOMContentLoaded", inject, { once: true });
  });
  page.on("pageerror", (e) => log(`[${slug}] pageerror:`, e.message || String(e)));
  page.on("console", (m) => {
    if (m.type() === "error") log(`[${slug}] console.error:`, m.text());
  });
  page.on("requestfailed", (r) => log(`[${slug}] requestfailed:`, r.url(), r.failure()?.errorText));
  page.on("response", (r) => {
    if (r.status() >= 400) log(`[${slug}] HTTP ${r.status()}:`, r.url());
  });
  try {
    await page.goto(textureBaseUrl + "/harness.html", { waitUntil: "domcontentloaded", timeout: 60000 });
  } catch (e) {
    log(`[${slug}] goto failed:`, e.message || String(e));
  }
  try {
    await page.waitForFunction("window.__mrpReady === true", { timeout: 60000 });
  } catch (e) {
    const html = await page.content().catch(() => "<no content>");
    log(`[${slug}] __mrpReady never set; page html snippet:`, html.slice(0, 800));
    throw e;
  }

  const dbg = await page.evaluate(() => ({
    ready: !!window.__mrpReady,
    setMesh: typeof window.__mrpSetMesh,
    render: typeof window.__mrpRender,
    threeLoaded: typeof THREE !== "undefined" || typeof window.THREE !== "undefined",
  }));
  log(`[${slug}] harness state:`, JSON.stringify(dbg));

  await page.evaluate(async (m, base) => window.__mrpSetMesh(m, base), mesh, textureBaseUrl);

  // Headshot: orthographic isometric camera (no vanishing points).
  await page.evaluate(async (az, w, h, iso) => window.__mrpRender(az, w, h, iso), 30, opts.width, opts.height, true);
  const headPath = path.join(outDir, "headshot.png");
  await page.screenshot({ path: headPath, omitBackground: true, type: "png" });
  await assertCornersTransparent(headPath);
  log(`[${slug}] headshot captured (${opts.width}x${opts.height})`);

  if (!opts.skipSpin) {
    for (let i = 0; i < opts.frames; i++) {
      const az = (360 * i) / opts.frames;
      // Spin frames: perspective camera (orbit with vanishing points).
      await page.evaluate(async (a, w, h, iso) => window.__mrpRender(a, w, h, iso), az, opts.width, opts.height, false);
      const framePath = path.join(outDir, "spin", `${String(i).padStart(3, "0")}.png`);
      await page.screenshot({ path: framePath, omitBackground: true, type: "png" });
    }
    if (opts.frames > 0) {
      await assertCornersTransparent(path.join(outDir, "spin", "000.png"));
    }
    log(`[${slug}] spin captured (${opts.frames} frames)`);
  }

  await page.close();
  return { slug, headshot: headPath, spinFramesDir: path.join(outDir, "spin"), frames: opts.skipSpin ? 0 : opts.frames };
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  let toRender;
  if (opts.entity) {
    const meshPath = path.join(MESH_DIR, `${entitySlug(opts.entity)}.json`);
    if (!fs.existsSync(meshPath)) {
      throw new Error(`no mesh JSON at ${meshPath}; run parse-geometry first`);
    }
    toRender = [readJson(meshPath)];
  } else {
    if (!fs.existsSync(RUN_PLAN_PATH)) throw new Error("no run-plan.json; run diff-entities");
    const plan = readJson(RUN_PLAN_PATH);
    toRender = (plan.to_render || [])
      .map((id) => path.join(MESH_DIR, `${entitySlug(id)}.json`))
      .filter((p) => fs.existsSync(p))
      .map((p) => readJson(p));
  }
  log(`capture: ${toRender.length} mobs`);

  const { server, base } = await startServer(DIRS.root);
  log(`harness server listening at ${base}`);

  const puppeteer = (await import("puppeteer")).default;
  const browser = await puppeteer.launch({
    headless: "new",
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--use-gl=angle",
      "--use-angle=swiftshader",
      "--enable-unsafe-swiftshader",
      "--enable-webgl",
      "--ignore-gpu-blocklist",
    ],
  });

  const results = [];
  let ok = 0;
  let fail = 0;
  for (const mesh of toRender) {
    try {
      const r = await captureOne(browser, mesh, opts, base);
      results.push(r);
      ok++;
    } catch (err) {
      log(`[${mesh.slug}] capture FAILED:`, err && err.stack ? err.stack : String(err));
      fail++;
    }
  }
  await browser.close();
  server.close();
  writeJson(path.join(DIRS.cache, "capture.json"), { results, ok, fail });
  log(`capture done: ok=${ok} fail=${fail}`);
}

main().catch((err) => {
  console.error("capture fatal:", err);
  process.exit(1);
});