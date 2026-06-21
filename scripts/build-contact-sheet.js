#!/usr/bin/env node
// scripts/build-contact-sheet.js
//
// Composites all output/<slug>/headshot.png into a single labeled grid PNG
// at output/contact-sheet.png so the whole render set can be eyeballed at
// once for QA. Each cell is the headshot scaled to a thumbnail, with the
// entity slug labeled below it.
//
// Usage:
//   node scripts/build-contact-sheet.js                 // all entities in manifest
//   node scripts/build-contact-sheet.js --columns 8     // grid columns (default 8)
//   node scripts/build-contact-sheet.js --cell 128      // thumbnail size (default 128)
//   node scripts/build-contact-sheet.js --out foo.png   // alternate output path

import fs from "node:fs";
import path from "node:path";
import { readJson, DIRS } from "./lib.js";

function parseArgs(argv) {
  const o = { columns: 8, cell: 128, out: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--columns") o.columns = parseInt(argv[++i], 10);
    else if (argv[i] === "--cell") o.cell = parseInt(argv[++i], 10);
    else if (argv[i] === "--out") o.out = argv[++i];
  }
  return o;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const sharp = (await import("sharp")).default;
  const manifestPath = path.join(DIRS.output, "manifest.json");
  if (!fs.existsSync(manifestPath)) {
    throw new Error("no manifest.json; run the pipeline first");
  }
  const manifest = readJson(manifestPath);
  const entities = Object.entries(manifest.entities || {})
    .filter(([_, e]) => e.headshot)
    .map(([id, e]) => ({ id, slug: e.headshot.split("/")[0], headshot: path.join(DIRS.output, e.headshot) }))
    .filter((e) => fs.existsSync(e.headshot))
    .sort((a, b) => a.slug.localeCompare(b.slug));

  if (!entities.length) {
    console.error("no headshots found");
    process.exit(0);
  }

  const cell = opts.cell;
  const labelH = Math.max(16, Math.round(cell * 0.14)); // label strip height
  const padding = 2;
  const cols = Math.min(opts.columns, entities.length);
  const rows = Math.ceil(entities.length / cols);
  const gridW = cols * (cell + padding) + padding;
  const gridH = rows * (cell + labelH + padding) + padding;

  // Build a flat background canvas with full alpha.
  const base = sharp({
    create: { width: gridW, height: gridH, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
  });

  // Compose each cell onto the canvas.
  const composites = [];
  for (let i = 0; i < entities.length; i++) {
    const col = i % cols;
    const row = Math.floor(i / cols);
    const x = padding + col * (cell + padding);
    const y = padding + row * (cell + labelH + padding);
    // Scale headshot into cell×cell, preserving alpha. Add a label strip below
    // with the slug text via SVG overlay.
    const thumb = await sharp(entities[i].headshot)
      .resize(cell, cell, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .png()
      .toBuffer();
    composites.push({ input: thumb, left: x, top: y });
    // Label: render text as SVG, composite below the thumb.
    const fontSize = Math.max(10, Math.round(cell * 0.12));
    const slug = entities[i].slug.replace(/&/g, "&amp;").replace(/</g, "&lt;");
    const labelSvg = Buffer.from(
      `<svg xmlns="http://www.w3.org/2000/svg" width="${cell}" height="${labelH}">
        <text x="${cell / 2}" y="${labelH - 2}" font-family="monospace" font-size="${fontSize}" fill="#ffffff" text-anchor="middle">${slug}</text>
      </svg>`,
    );
    composites.push({ input: labelSvg, left: x, top: y + cell });
  }

  const outPath = opts.out || path.join(DIRS.output, "contact-sheet.png");
  await base.composite(composites).png({ compressionLevel: 9 }).toFile(outPath);
  console.log(`contact sheet: ${entities.length} mobs, ${cols}x${rows} grid -> ${outPath} (${gridW}x${gridH})`);
}

main().catch((err) => {
  console.error("build-contact-sheet fatal:", err);
  process.exit(1);
});