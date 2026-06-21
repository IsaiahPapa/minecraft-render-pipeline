# AGENTS.md — opencode agent notes

## Project

Minecraft Bedrock mob render pipeline. See `mob-render-pipeline-spec.md` for
the authoritative specification. The pipeline downloads the Bedrock
Dedicated Server zip, extracts `resource_packs/vanilla/`, parses each
entity's `.geo.json` into a normalized mesh JSON, renders it with `three.js`
in a headless Chromium (Puppeteer) page, captures transparent PNGs, and
post-processes them into headshots + spin animations committed to `output/`.

## Commands

- Install deps: `npm install`
- Full pipeline: `node cli.js`
- Single entity (dev): `node cli.js --entity minecraft:cow --skip-spin`
- Force re-render of everything: `node cli.js --force-all`
- Reuse previously extracted pack offline: `MRP_SKIP_DOWNLOAD=1 node cli.js`
- Lint: `npm run lint`
- Format: `npm run format`

Individual phases (used by `cli.js` but runnable standalone for debugging):
- `node scripts/fetch-version.js`
- `node scripts/extract-pack.js`
- `node scripts/diff-entities.js`
- `node scripts/parse-geometry.js`
- `node render/capture.js --entity minecraft:cow --skip-spin`
- `node postprocess/trim-and-pad.js --entity minecraft:cow`
- `node postprocess/encode-spin.js --entity minecraft:cow`
- `node scripts/build-manifest.js`

## Layout

- `scripts/` — version watcher, pack extractor, entity diff, geometry parser,
  manifest builder, and shared `lib.js`.
- `render/` — `harness.html` (three.js scene loaded by Puppeteer) and
  `capture.js` (Puppeteer driver).
- `postprocess/` — `trim-and-pad.js` (square framing with full alpha) and
  `encode-spin.js` (animated WebP + legacy GIF).
- `data/` — `last-known-version.json`, `last-known-entities.json`,
  `overrides.json` (hand-maintained Java-exclusive / override list).
- `cache/` — gitignored. Holds downloaded zip, extracted vanilla pack,
  per-entity mesh JSON, and per-entity captured frames.
- `output/` — generated assets. `manifest.json` is the entry point.

## Constraints worth remembering

- Never JPEG. Capture PNG only; the harness uses `alpha: true` +
  `setClearColor(0x000000, 0)` and `page.screenshot({ omitBackground: true })`.
  After capture, `render/capture.js` verifies the four corner pixels have
  `alpha == 0` — this is an automated check, not visual.
- Box-UV unwrapping (spec §6.4) is the most error-prone part. The table is
  implemented in `scripts/parse-geometry.js` (`boxUvFaces`). If textures look
  scrambled, cross-check against Blockbench source before tweaking.
- Post-processing must preserve alpha end-to-end. Do NOT use sharp's
  `.flatten()`. Always `extend` with `{ r: 0, g: 0, b: 0, alpha: 0 }`.
- Idempotency: re-running against an unchanged Bedrock version must produce no
  git diff. `cli.js` exits early when the version is unchanged and
  `--force-all` is not set.
- GIF is a legacy export with 1-bit alpha (jagged edges). Animated WebP is the
  primary deliverable. This tradeoff is documented in the README, not silent.