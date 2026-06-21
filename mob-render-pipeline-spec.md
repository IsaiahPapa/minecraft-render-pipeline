# Minecraft mob render pipeline — technical specification

Status: draft, ready for implementation
Audience: an AI coding agent (or human) bootstrapping a new repository from scratch

## 1. Purpose

Build an open-source, automated pipeline that produces transparent-background
PNG "headshot" thumbnails and rotating spin animations for every mob in
Minecraft, with zero manual intervention as new mobs are added in future game
updates. Output is published to a public git repository for anyone to use.

This is a standalone asset-generation project. It does not include, and
should not grow to include, the downstream application that will consume
these images.

## 2. Goals

- Render every mob defined in the current Minecraft: Bedrock Edition vanilla
  resource pack, fully automatically, with no per-mob manual configuration on
  the happy path.
- Two output artifacts per mob:
  - A square, transparent-background "headshot" PNG suitable for a UI icon
    or picker list.
  - A rotating "spin" animation (360° turntable) of the same mob, transparent
    background.
- A repeatable CI pipeline (GitHub Actions) that detects new Minecraft
  versions, re-runs the render for new/changed mobs only, and commits the
  result with no human in the loop.
- A small, explicitly-tracked fallback path for mobs that cannot be rendered
  from the Bedrock data (Java-exclusive mobs, short-lived parity gaps,
  entities whose default appearance needs a manual override).

## 3. Non-goals

- No live Minecraft client, Microsoft account, or game license is required
  anywhere in this pipeline.
- Not attempting pixel-parity with the Minecraft Wiki's hand-made renders.
- Not rendering held items, armor, or other equipment variants in v1.
- Not implementing animation playback (walk cycles, idle animations) — see
  §6.5 for why this isn't needed even for the spin animation.
- Not building the consuming application (e.g. a UI picker). This repo only
  produces image assets and a manifest describing them.

## 4. Why Bedrock data instead of a Java client/mod

Java Edition entity geometry (the cuboid shapes that make up a mob's model)
is hardcoded in compiled Java classes inside the client jar — it is not
exposed as data. There is no file to parse; you would need to either run the
actual game client (what tools like the Fabric mod "Isometric Renders" do)
or decompile/reverse-engineer the model classes per version.

Bedrock Edition's entity format is the opposite: fully data-driven JSON.
Each mob has an `entity.json` (which geometry/texture/render controller to
use) and a `.geo.json` (the actual cuboid geometry: bones, pivots, cube
sizes, UV mapping). This is the same format the game itself reads, so a
parser written against this format keeps working as Mojang adds mobs,
without any code changes, as long as the JSON schema stays
backward-compatible (it has been for years).

This is why the pipeline targets Bedrock's data as its primary source, with
a manual fallback for the handful of cases where Java and Bedrock diverge.

## 5. Data source

- Minecraft: Bedrock Dedicated Server (BDS) is distributed by Mojang as a
  free zip for Windows and Linux, no account required.
- Current download links are available from a stable public JSON endpoint:
  `https://net-secondary.web.minecraft-services.net/api/v1.0/download/links`
  — filter the response for the Linux server build. This endpoint is already
  relied on by several existing community auto-update scripts for Bedrock
  servers, so treat it as a stable integration point, but write the version
  check defensively (handle the endpoint being slow/unavailable/changed shape)
  since it is not a documented, versioned API.
- The downloaded zip contains `resource_packs/vanilla/`, which has:
  - `entity/*.entity.json` — one file per mob, declares which geometry,
    texture(s), materials, and render controller it uses.
  - `models/entity/*.geo.json` — the actual cuboid geometry.
  - `textures/entity/**/*.png` — texture images.
  - `render_controllers/*.json` — selects between texture/geometry variants,
    sometimes via conditional (Molang) expressions.
- Do not depend on any third-party mirror of these files for the live
  pipeline — pull directly from the official zip each run. A mirror is fine
  to consult as a reference while developing, not as a runtime dependency.

## 6. Component specifications

### 6.1 Version watcher

Polls the download-links endpoint, extracts the current Bedrock server
version number from the returned URL or accompanying metadata, and compares
it against the last-processed version recorded in the repo (see
`data/last-known-version.json`). Exits early (no-op) if unchanged. This is
the trigger for the whole pipeline and should be runnable both on a
schedule and via manual dispatch.

### 6.2 Pack extractor

Downloads the zip identified above, extracts only
`resource_packs/vanilla/**`, and discards the rest of the server
distribution (behavior packs, server binary, etc. are not needed).

### 6.3 Entity diff / manifest builder

Walks `entity/*.entity.json`, building a list of every
`minecraft:client_entity.description.identifier` found. Diffs this list
against `data/last-known-entities.json`. Produces three buckets for this
run:
- `new` — identifiers not seen before. These get rendered.
- `removed` — identifiers no longer present (should be rare; flag, don't
  silently delete existing output).
- `unchanged` — skip re-rendering these to keep CI runs fast and diffs
  meaningful.

A `--force-all` flag should exist for full re-renders (e.g. after a renderer
bug fix changes output for everything).

### 6.4 Geometry parser (`.geo.json` → mesh)

For each entity to render, resolve via its `entity.json` and (if needed)
`render_controllers/*.json` which `geometry` and `texture` to use. For v1,
always take the first/default texture and ignore conditional render
controller logic (wolf anger state, sheep wool color, horse markings, etc.)
— see §12 for the tradeoff this implies.

Parse the referenced `.geo.json`:
- `bones[]`: each has a `name`, optional `parent`, `pivot [x,y,z]`, optional
  `rotation`, and a `cubes[]` array.
- `cubes[]`: each has `origin [x,y,z]`, `size [w,h,d]`, a `uv` (either a
  single `[u,v]` anchor using box-UV unwrapping, or a per-face object —
  handle both), optional `inflate`, optional `mirror`.

Build a scene graph: one transform node per bone, parented according to
`parent`, with each bone's cubes converted into mesh geometry positioned
relative to that bone's pivot.

**Box-UV reference** (when a cube has a single `[u, v]` anchor rather than
per-face UVs): for a cube of size `(dx, dy, dz)` with anchor `(u, v)` in
pixels, the standard Minecraft cross-layout is:

| Face  | UV origin            | UV size    |
|-------|-----------------------|------------|
| Top   | `(u+dz, v)`           | `(dx, dz)` |
| Bottom| `(u+dz+dx, v)`        | `(dx, dz)` |
| Right | `(u, v+dz)`           | `(dz, dy)` |
| Front | `(u+dz, v+dz)`        | `(dx, dy)` |
| Left  | `(u+dz+dx, v+dz)`     | `(dz, dy)` |
| Back  | `(u+dz+dx+dz, v+dz)`  | `(dx, dy)` |

Do not trust this table blindly — cross-check it against Blockbench's own
source (MIT-licensed, github.com/JannisX11/blockbench), which already
implements this format correctly and is the de facto reference
implementation for the whole Bedrock modding community. A subtly wrong face
order/flip is the most likely source of "model looks right but texture is
scrambled" bugs.

Recommended implementation: Node.js + `three.js`. Build one `THREE.Group`
per bone, one merged `BufferGeometry` per bone (or per cube, simpler but
slower) with explicit UVs computed from the table above, nested according to
the parent hierarchy.

### 6.5 Render harness

A minimal HTML page (no framework needed) that:
- Sets up a `THREE.WebGLRenderer` with **`alpha: true`** and a transparent
  clear color (`renderer.setClearColor(0x000000, 0)`).
- Accepts a mob's parsed mesh + texture (via query param, injected JSON, or
  a small local HTTP server) and adds it to the scene.
- Uses flat, even lighting (ambient + one soft directional light, no harsh
  shadows) to look in-style with vanilla Minecraft's own item/GUI icon
  rendering rather than a dramatic 3D render.
- For the headshot: positions an isometric-style camera (suggest matching
  Minecraft's own classic item-render angle, roughly 30° elevation, and tune
  azimuth/zoom per the auto-crop step in §6.8 rather than per-mob).
- For the spin: re-renders the same scene at N evenly-spaced azimuth angles
  (orbit the camera around the Y axis, or equivalently rotate the model — do
  not use the mob's own animation rig; a static-pose 360° orbit is sufficient
  and avoids needing `.animation.json` support at all).

No animation playback is required anywhere in this pipeline. Both the
headshot and the spin are pure camera-orbit renders of the model in its
rest pose as defined directly in the `.geo.json`.

### 6.6 Capture driver

Use Puppeteer to load the harness page headlessly and capture frames.

**Transparency requirements — these are not optional:**
- Capture as PNG, never JPEG (JPEG has no alpha channel).
- Call `page.screenshot()` with `omitBackground: true`, and make sure the
  page's own `<html>`/`<body>` have no background color set (default is
  transparent, but double-check — some default browser stylesheets or CSS
  resets force white).
- After capture, verify programmatically that the resulting PNG's corner
  pixels have `alpha = 0`, not just "looks transparent" in a viewer. Add this
  as an automated check, not a visual spot-check.
- If headless Chromium's default WebGL backend has trouble in the CI
  environment, fall back to running under Xvfb (same pattern used in the
  earlier Java-mod approach) rather than disabling alpha or compositing onto
  a solid color to work around it.

### 6.7 Spin animation encoder

Encode the N captured frames into an animation. Two real constraints here:

- **GIF only supports 1-bit (on/off) transparency per pixel** — no
  anti-aliased alpha. Any GIF output will have visibly jagged edges around
  the mob's silhouette. This is a format limitation, not a bug in your
  encoder.
- Produce an **animated WebP** (or APNG) as the primary deliverable — both
  support full 8-bit alpha and will look correct. Offer GIF as a secondary,
  clearly-labeled "legacy/compatibility" export for consumers that require
  `.gif` specifically, with the jagged-edge tradeoff documented in the
  manifest or README, not silently.

### 6.8 Post-processing

After rendering, for every output image:

1. Trim to the actual non-transparent content's bounding box.
2. Center and pad into a fixed square canvas (e.g. 512×512 for headshots).

This is what makes framing consistent across wildly different mob sizes
(a silverfish and a warden) without any per-mob camera tuning. It must be
done with full alpha preserved end to end — if using `sharp` in Node, avoid
`.flatten()`, and when extending/padding the canvas explicitly set the fill
to `{ r: 0, g: 0, b: 0, alpha: 0 }`, not white or black.

### 6.9 Java fallback / overrides

Maintain `data/overrides.json`: a small, hand-maintained list of entity
identifiers that either (a) don't appear in the Bedrock vanilla pack at all,
or (b) render with a default texture/variant that looks wrong/unrecognizable
and needs a manual override. Each entry points to a manually-produced asset
(rendered via the Java/Isometric Renders route, or hand-edited) that gets
dropped into the same output structure and manifest, flagged
`"source": "manual"` so consumers/maintainers know it isn't part of the
automated path. Expect this list to be short.

## 7. Output structure

```
output/
  <entity_slug>/
    headshot.png
    spin.webp
    spin.gif
  manifest.json
```

`entity_slug` = the identifier with the `minecraft:` namespace stripped and
`:` replaced with `_` (e.g. `minecraft:warden` → `warden`).

`manifest.json`:

```json
{
  "minecraft_version": "1.21.80",
  "generated_at": "2026-06-21T00:00:00Z",
  "entities": {
    "minecraft:warden": {
      "headshot": "warden/headshot.png",
      "spin_webp": "warden/spin.webp",
      "spin_gif": "warden/spin.gif",
      "source": "bedrock",
      "needs_review": false
    },
    "minecraft:example_exclusive": {
      "headshot": "example_exclusive/headshot.png",
      "source": "manual",
      "needs_review": true
    }
  }
}
```

## 8. Proposed repository layout

```
/scripts
  fetch-version.js        // polls the download-links endpoint
  extract-pack.js         // downloads + unzips BDS, pulls vanilla RP
  diff-entities.js        // compares against last-known-entities.json
  parse-geometry.js       // .geo.json -> normalized mesh JSON
/render
  harness.html            // three.js scene loaded by Puppeteer
  capture.js              // Puppeteer driver: headshot + spin frames
/postprocess
  trim-and-pad.js
  encode-spin.js
/data
  last-known-version.json
  last-known-entities.json
  overrides.json
/output                    // generated; decide whether this is committed
                            // directly or attached to GitHub Releases
/.github/workflows/render.yml
README.md                  // must include the disclaimer from §13
LICENSE
```

This is a starting proposal, not a constraint — adjust as implementation
reveals better boundaries.

## 9. Automation requirements (GitHub Actions)

- Scheduled trigger (e.g. weekly) plus manual `workflow_dispatch`.
- Steps: version check → exit early if unchanged → extract pack → diff
  entities → render new/changed entities → post-process → update manifest →
  commit (or open a PR) → optionally cut a GitHub Release tagged with the
  Minecraft version.
- Re-running against the same Minecraft version with no source changes must
  produce no diff (idempotent), so CI doesn't generate noise commits.

## 10. Phased implementation plan

Work through these in order; each phase should be independently runnable
and verifiable before moving to the next.

1. **Single-mob proof of concept.** Manually download one BDS zip. Get
   `cow.geo.json` + its texture parsed and rendered correctly, locally, as a
   single transparent PNG. Verify visually that proportions and texture
   placement are correct before generalizing anything.
2. **Full entity loop.** Generalize to every entity found in the extracted
   pack. Batch-render headshots for all of them.
3. **Spin animation.** Add the camera-orbit capture and WebP/GIF encoding.
4. **Post-processing.** Auto-crop/pad to consistent square framing; build
   `manifest.json`.
5. **Automation.** Version-watcher script + GitHub Actions workflow wiring
   it all together; incremental (diff-based) rendering.
6. **Fallback handling.** `overrides.json` support, `needs_review` flagging,
   README documentation of known gaps.

## 11. Acceptance criteria

- A single command renders a correct, recognizable, transparent-background
  headshot for at least one test mob, with verified `alpha = 0` at the
  image corners.
- A full pipeline run produces a headshot + spin animation for every entity
  in the extracted vanilla pack, with no per-mob manual configuration
  required on the happy path.
- Re-running against an unchanged Minecraft version produces no output diff.
- Adding a new Minecraft version's data causes only the new/changed
  entities to be (re-)rendered, not a full re-render of everything (this can
  be deferred as a phase-5 optimization if needed for initial launch).

## 12. Known limitations

- Render controller conditional logic (color/pattern variants driven by
  Molang expressions) is not evaluated in v1 — every mob renders its
  default/first variant. Some mobs may look less "iconic" than a
  hand-picked variant would.
- Java and Bedrock mob lists are not always identical, especially in the
  weeks after a new mob ships to one edition before the other. This is what
  `overrides.json` and the `needs_review` flag are for.
- This pipeline programmatically derives renders from Mojang's own
  copyrighted game assets. See §13.

## 13. Licensing / disclaimer

This project is not affiliated with, endorsed by, or sponsored by Mojang
Studios or Microsoft. It renders assets programmatically from Mojang's
publicly distributed Bedrock Dedicated Server files for non-commercial,
fan-use purposes. The README must state this clearly. If Mojang or
Microsoft request removal of any generated content, that request will be
honored.

## 14. Reference material

- Bedrock client entity JSON format: Microsoft Learn, "Client Entity JSON
  and Introduction."
- Bedrock dedicated server download links: confirm current shape of
  `net-secondary.web.minecraft-services.net/api/v1.0/download/links` before
  relying on it; it is not a versioned/documented public API, just a stable
  endpoint in practice.
- Blockbench source (github.com/JannisX11/blockbench) — canonical reference
  implementation for parsing this exact model format.
