#!/usr/bin/env node
// scripts/parse-geometry.js
// §6.4 Geometry parser (.geo.json -> normalized mesh JSON)
//
// For each entity to render:
//   1. Read its entity.json to find the geometry hash / name and texture path.
//   2. (v1) ignore render controller conditional logic — take the first
//      default geometry + first texture.
//   3. Load the referenced .geo.json, walk bones[] and cubes[], build a
//      normalized scene-graph mesh JSON with explicit per-face UVs computed
//      from the box-UV table in the spec.
//
// Output: cache/meshes/<entity_slug>.json with this shape:
//   {
//     "identifier": "minecraft:cow",
//     "texture": "cache/extracted/resource_pack/textures/entity/cow/cow.png",
//     "texture_size": [w,h],
//     "bones": [
//       { "name": "body", "parent": null, "pivot": [x,y,z], "rotation": [0,0,0],
//         "cubes": [ { "origin":[x,y,z], "size":[w,h,d], "uv": { per-face uv }, "inflate": 0, "mirror": false } ] }
//     ]
//   }
//
// The render harness consumes this JSON directly (no .geo.json knowledge there).
//
// Usage:
//   node scripts/parse-geometry.js                // parse everything in run-plan.to_render
//   node scripts/parse-geometry.js --entity minecraft:cow

import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
import { readJson, writeJson, log, DIRS, entitySlug, ensureDir } from "./lib.js";

// Load rest-pose rotation overrides (data/overrides.json). Each entry
// overrides the rotation of ALL cubes in the named bone for the given
// entity, applied at CUBE level (not bone level) so child bones don't
// inherit the rotation. This fixes quadrupeds whose Bedrock geo file
// authors the body cube vertical with no bone rotation (cat, cow.v2,
// pig.v3, ocelot, wolf, fox, llama, mooshroom, panda, etc.).
const OVERRIDES_PATH = path.join(DIRS.root, "data", "overrides.json");
let REST_POSE = {};
try {
  const ov = readJson(OVERRIDES_PATH);
  REST_POSE = ov.rest_pose_rotations || {};
} catch {
  log("parse-geometry: could not load overrides.json; rest-pose overrides disabled");
}

const RP = path.join(DIRS.extracted, "resource_pack");
const ENTITY_DIR = path.join(RP, "entity");
const GEO_DIR = path.join(RP, "models", "entity");
const TEX_DIR = path.join(RP, "textures");
const RUN_PLAN_PATH = path.join(DIRS.cache, "run-plan.json");
const MESH_DIR = path.join(DIRS.cache, "meshes");

function parseArgs(argv) {
  const o = { entity: null };
  for (let i = 0; i < argv.length; i++) if (argv[i] === "--entity") o.entity = argv[++i];
  return o;
}

// --- entity.json resolution -------------------------------------------------
//
// bedrock-samples entity file shape:
//   {
//     "format_version": "1.10.0",
//     "minecraft:client_entity": {
//       "description": {
//         "identifier": "minecraft:cow",
//         "geometry": { "default": "geometry.cow.v2", "warm": "geometry.cow.warm", ... },
//         "textures":  { "default": "textures/entity/cow/cow_v2", ... },
//         "render_controllers": [ "controller.render.cow.v3" ]
//       }
//     }
//   }
// Some files use the older pre-1.10 shape where the entity id is a top-level
// key with a nested { description: ... }. We handle both.

function loadEntityJson(identifier) {
  if (!fs.existsSync(ENTITY_DIR)) return null;
  for (const f of fs.readdirSync(ENTITY_DIR)) {
    if (!f.endsWith(".json")) continue;
    const fp = path.join(ENTITY_DIR, f);
    let doc;
    try {
      doc = readJson(fp);
    } catch {
      continue;
    }
    // Modern shape: top-level "minecraft:client_entity".
    if (doc["minecraft:client_entity"]) {
      const desc = doc["minecraft:client_entity"].description;
      if (desc && desc.identifier === identifier) {
        return { desc, file: fp };
      }
      continue;
    }
    // Older shape: top-level key matching the identifier.
    if (doc[identifier]) {
      const desc = doc[identifier].description || doc[identifier]?.client_entity?.description;
      if (desc) return { desc, file: fp };
    }
  }
  return null;
}

function resolveGeometryAndTexture(identifier) {
  const found = loadEntityJson(identifier);
  if (!found) return null;
  const desc = found.desc;
  if (!desc) return null;

  // geometry: object { "<variant>": "geometry.<name>" } OR a string OR array.
  // v1: take the "default" variant if present, else the first key.
  let geoRef = null;
  if (desc.geometry) {
    if (typeof desc.geometry === "string") geoRef = desc.geometry;
    else if (Array.isArray(desc.geometry)) geoRef = desc.geometry[0];
    else if (typeof desc.geometry === "object") {
      geoRef = desc.geometry.default || Object.values(desc.geometry)[0];
    }
  }
  if (!geoRef) return null;

  // textures: object { "<variant>": "textures/..." } OR string OR array.
  // v1: take the "default" variant if present, else the first key.
  let texRef = null;
  if (desc.textures) {
    if (typeof desc.textures === "string") texRef = desc.textures;
    else if (Array.isArray(desc.textures)) texRef = desc.textures[0];
    else if (typeof desc.textures === "object") {
      texRef = desc.textures.default || Object.values(desc.textures)[0];
    }
  }

  return {
    geoRef,
    texRef,
    renderControllers: desc.render_controllers || null,
    identifier,
    entityFile: found.file,
    description: desc,
  };
}

// --- geometry loading ------------------------------------------------------
//
// bedrock-samples geo file shape (legacy 1.8 / 1.10 / 1.12 / 1.16):
//   {
//     "format_version": "1.8.0",
//     "geometry.cow.v1.8": {            <- top-level key IS the geometry name
//       "texturewidth": 64, "textureheight": 32,
//       "bones": [ ... ]
//     }
//   }
// OR the newer 1.16+ shape:
//   {
//     "format_version": "1.16.0",
//     "minecraft:geometry": [
//       { "description": { "identifier": "geometry.cow", ... }, "bones": [ ... ] }
//     ]
//   }
// The entity.json references a geometry by its name (e.g. "geometry.cow.v2").
// We search all .geo.json files for a top-level key matching that name.

function loadGeoByName(geoRef) {
  // geoRef like "geometry.cow.v2" — used directly as the key in older format,
  // or matched against description.identifier in newer format.
  if (!fs.existsSync(GEO_DIR)) return null;
  const want = geoRef;
  for (const f of fs.readdirSync(GEO_DIR)) {
    if (!f.endsWith(".geo.json") && !f.endsWith(".json")) continue;
    if (!f.endsWith(".geo.json")) continue; // only .geo.json files
    let doc;
    try {
      doc = readJson(path.join(GEO_DIR, f));
    } catch {
      continue;
    }
    // Older shape: top-level key is the geometry name.
    for (const key of Object.keys(doc)) {
      if (key === "format_version") continue;
      if (key === want) {
        return { doc: doc[key], file: path.join(GEO_DIR, f) };
      }
    }
    // Newer shape: minecraft:geometry array.
    if (Array.isArray(doc["minecraft:geometry"])) {
      for (const g of doc["minecraft:geometry"]) {
        const desc = g.description || {};
        const id = desc.identifier;
        if (id === want) {
          return { doc: g, file: path.join(GEO_DIR, f) };
        }
      }
    }
  }
  return null;
}

function loadAnyGeo() {
  // Last-resort fallback for entities whose entity.json references a geometry
  // we cannot match by name. Take the first .geo.json's first geometry.
  if (!fs.existsSync(GEO_DIR)) return null;
  for (const f of fs.readdirSync(GEO_DIR)) {
    if (!f.endsWith(".geo.json")) continue;
    try {
      const doc = readJson(path.join(GEO_DIR, f));
      for (const key of Object.keys(doc)) {
        if (key === "format_version") continue;
        return { doc: doc[key], file: path.join(GEO_DIR, f) };
      }
    } catch {
      /* ignore malformed geo file */
    }
  }
  return null;
}

// --- texture size ----------------------------------------------------------

// Convert a .tga file to a .png in cache/textures/ and return the PNG path.
// sharp cannot read TGA natively, so we decode via the `tga` package and
// feed the raw RGBA pixels to sharp as a raw buffer.
async function tgaToPng(tgaPath) {
  const TGA = require("tga");
  const sharp = require("sharp");
  const buf = fs.readFileSync(tgaPath);
  const tga = new TGA(buf);
  const w = tga.width;
  const h = tga.height;
  // tga.pixels is RGBA (4 bytes/pixel). The `tga` package handles row
  // flipping, so pixels are top-down.
  const pngDir = path.join(DIRS.cache, "textures");
  ensureDir(pngDir);
  const rel = path.relative(TEX_DIR, tgaPath).replace(/\.tga$/i, ".png");
  const outPath = path.join(pngDir, rel);
  ensureDir(path.dirname(outPath));
  await sharp(Buffer.from(tga.pixels), {
    raw: { width: w, height: h, channels: 4 },
  })
    .png({ compressionLevel: 9 })
    .toFile(outPath);
  return outPath;
}

// Read a texture_set.json and return the path to the "color" texture (TGA).
function resolveTextureSetColor(texRef) {
  // texRef like "textures/entity/spider/spider" — look for <ref>.texture_set.json
  const setPath = path.join(RP, texRef + ".texture_set.json");
  if (!fs.existsSync(setPath)) return null;
  try {
    const doc = readJson(setPath);
    const color = doc["minecraft:texture_set"]?.color;
    if (!color || typeof color !== "string") return null;
    // color is a bare name relative to the same directory as the set file.
    const dir = path.dirname(setPath);
    const candidates = [
      path.join(dir, color + ".tga"),
      path.join(dir, color + ".png"),
      path.join(dir, color),
    ];
    for (const c of candidates) if (fs.existsSync(c)) return c;
  } catch {
    return null;
  }
  return null;
}

async function resolveTexturePath(texRef) {
  if (!texRef) return null;
  // texRef is a path relative to the resource_pack root, e.g.
  // "textures/entity/cow/cow" or "textures/entity/spider/spider".
  // Search candidate roots and extensions.
  const exts = [".png", ".tga", ""];
  const roots = [path.join(RP, texRef), path.join(DIRS.root, texRef)];
  const candidates = [];
  for (const r of roots) for (const e of exts) candidates.push(r + e);

  for (const c of candidates) {
    if (fs.existsSync(c)) {
      if (c.endsWith(".tga")) {
        // Convert to PNG and return the converted path.
        return await tgaToPng(c);
      }
      return c;
    }
  }

  // Fall back to texture_set.json (newer format).
  const tgaViaSet = resolveTextureSetColor(texRef);
  if (tgaViaSet) {
    if (tgaViaSet.endsWith(".tga")) return await tgaToPng(tgaViaSet);
    return tgaViaSet;
  }
  return null;
}

function pngDimensions(p) {
  const b = fs.readFileSync(p);
  if (b.length < 24 || b[0] !== 0x89) return null;
  // IHDR width/height at bytes 16..24.
  const w = b.readUInt32BE(16);
  const h = b.readUInt32BE(20);
  return [w, h];
}

// --- box-UV unwrapping ------------------------------------------------------
// Spec §6.4 table. Texture coordinates are in pixels; convert to 0..1 by
// dividing by texture_size. Face vertex order is chosen to match a
// counter-clockwise winding when viewed from outside.

function faceUvPixels(u, v, w, h) {
  return { u, v, w, h };
}

// boxUvFaces(u, v, dx, dy, dz) -> { north, south, east, west, up, down }
// Uses Bedrock/Minecraft standard cross-layout per spec §6.4.
function boxUvFaces(u, v, dx, dy, dz) {
  return {
    // "north" = Front
    north: faceUvPixels(u + dz, v + dz, dx, dy),
    // "south" = Back
    south: faceUvPixels(u + dz + dx + dz, v + dz, dx, dy),
    // "east" = Right. Swapped with west relative to spec §6.4 table to
    // compensate for the bedrockToThree Z-flip: the Z-flip swaps which
    // physical side of the cube is "east" vs "west" from the camera's
    // perspective, so the texture strips must also swap to stay correct.
    east: faceUvPixels(u + dz + dx, v + dz, dz, dy),
    // "west" = Left
    west: faceUvPixels(u, v + dz, dz, dy),
    // "up" = Top
    up: faceUvPixels(u + dz, v, dx, dz),
    // "down" = Bottom
    down: faceUvPixels(u + dz + dx, v, dx, dz),
  };
}

// per-face UV object: { north: {uv:[u,v], uv_size:[w,h]}, ... }
function perFaceUvObject(uvObj) {
  const out = {};
  for (const faceName of ["north", "south", "east", "west", "up", "down"]) {
    const f = uvObj[faceName];
    if (!f) continue;
    if (Array.isArray(f.uv) && f.uv.length >= 2) {
      const w = Array.isArray(f.uv_size) ? f.uv_size[0] : 1;
      const h = Array.isArray(f.uv_size) ? f.uv_size[1] : 1;
      out[faceName] = faceUvPixels(f.uv[0], f.uv[1], w, h);
    }
  }
  return out;
}

function resolveCubeUv(cube) {
  const uv = cube.uv;
  if (Array.isArray(uv) && uv.length >= 2) {
    const [dx, dy, dz] = cube.size;
    return boxUvFaces(uv[0], uv[1], dx, dy, dz);
  }
  if (uv && typeof uv === "object") return perFaceUvObject(uv);
  // Missing UV — return zeroed faces so the mesh still builds.
  return boxUvFaces(0, 0, cube.size[0], cube.size[1], cube.size[2]);
}

// --- normalization ----------------------------------------------------------

function normalizeCube(cube, textureSize) {
  return normalizeCubeInternal(cube, textureSize, null);
}

function normalizeCubeWithOverride(cube, textureSize, overrideRotation) {
  return normalizeCubeInternal(cube, textureSize, overrideRotation);
}

function normalizeCubeInternal(cube, textureSize, overrideRotation) {
  const origin = cube.origin || [0, 0, 0];
  const size = cube.size || [0, 0, 0];
  const inflate = cube.inflate || 0;
  const mirror = !!cube.mirror;
  const uv = resolveCubeUv(cube);
  // Convert pixel UV to 0..1 using texture size, if known.
  const [tw, th] = textureSize || [16, 16];
  const norm = {};
  for (const face of ["north", "south", "east", "west", "up", "down"]) {
    const f = uv[face];
    if (!f) continue;
    norm[face] = {
      u: f.u / tw,
      v: f.v / th,
      w: f.w / tw,
      h: f.h / th,
      mirror,
    };
  }
  return {
    origin: [...origin],
    size: [...size],
    inflate,
    mirror,
    // Per-cube transform (Bedrock 1.16+ format): a cube may have its own
    // pivot and rotation, applied in addition to the bone's transform. The
    // cube rotates around cube.pivot (in bone-local space). Older formats
    // (1.8/1.10) don't set these; defaults are no-op.
    pivot: cube.pivot ? [...cube.pivot] : null,
    rotation: overrideRotation && !cube.rotation ? [...overrideRotation] : (cube.rotation ? [...cube.rotation] : null),
    uv: norm,
  };
}

function normalizeBone(bone, textureSize) {
  return {
    name: bone.name,
    parent: bone.parent || null,
    pivot: bone.pivot || [0, 0, 0],
    rotation: bone.rotation || bone.bind_pose_rotation || [0, 0, 0],
    cubes: (bone.cubes || []).map((c) => normalizeCube(c, textureSize)),
  };
}

function normalizeGeometry(geoDoc, textureSize, identifier) {
  const bones = geoDoc.bones || [];
  // Determine which bones have children (for override strategy).
  const childParents = new Set(bones.map((b) => b.parent).filter(Boolean));
  const rest = REST_POSE[identifier] || {};
  const normalizedBones = bones.map((b) => {
    const boneOv = rest[b.name];
    if (!boneOv) return normalizeBone(b, textureSize);
    const hasChildren = childParents.has(b.name);
    if (hasChildren) {
      // Cube-level override: zero bone rotation, set cube rotation.
      // Children stay at their authored body-local positions without
      // inheriting the body tip.
      return {
        name: b.name,
        parent: b.parent || null,
        pivot: b.pivot || [0, 0, 0],
        rotation: [0, 0, 0],
        cubes: (b.cubes || []).map((c) => normalizeCubeWithOverride(c, textureSize, boneOv)),
      };
    }
    // Bone-level override: no children to worry about.
    return {
      name: b.name,
      parent: b.parent || null,
      pivot: b.pivot || [0, 0, 0],
      rotation: [...boneOv],
      cubes: (b.cubes || []).map((c) => normalizeCube(c, textureSize)),
    };
  });
  return {
    name: geoDoc.name || geoDoc.identifier || geoDoc.description?.identifier || "default",
    texture_width: geoDoc.texturewidth || geoDoc.texture_width || textureSize[0] || 16,
    texture_height: geoDoc.textureheight || geoDoc.texture_height || textureSize[1] || 16,
    visible_bounds_width: geoDoc.visible_bounds_width || null,
    visible_bounds_height: geoDoc.visible_bounds_height || null,
    bones: normalizedBones,
  };
}

async function parseOne(identifier) {
  const resolved = resolveGeometryAndTexture(identifier);
  if (!resolved) {
    log(`[${identifier}] no entity.json; skipping`);
    return null;
  }
  let geo = loadGeoByName(resolved.geoRef);
  if (!geo) {
    log(`[${identifier}] geometry "${resolved.geoRef}" not found by name; falling back to first geo`);
    geo = loadAnyGeo();
  }
  if (!geo) {
    log(`[${identifier}] no .geo.json found at all; skipping`);
    return null;
  }
  const texPath = await resolveTexturePath(resolved.texRef);
  // Prefer the geo doc's texturewidth/textureheight (matches the texture the
  // model was authored against). Modern format stores these under
  // `description.texture_width/texture_height`; legacy v1.8 uses
  // `texturewidth/textureheight` at the top level. Fall back to PNG
  // dimensions, then to 16x16.
  let textureSize = [16, 16];
  const desc = geo.doc.description || {};
  const tw = geo.doc.texturewidth ?? desc.texture_width;
  const th = geo.doc.textureheight ?? desc.texture_height;
  if (tw && th) {
    textureSize = [tw, th];
  } else if (texPath) {
    const dim = pngDimensions(texPath);
    if (dim) textureSize = dim;
  }
  const mesh = {
    identifier,
    slug: entitySlug(identifier),
    geometry_name: geo.doc.name || geo.doc.identifier || geo.doc.description?.identifier || resolved.geoRef,
    geometry_file: path.relative(RP, geo.file),
    texture: texPath ? path.relative(DIRS.root, texPath) : null,
    texture_size: textureSize,
    geometry: normalizeGeometry(geo.doc, textureSize, identifier),
  };
  return mesh;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  let toRender;
  if (args.entity) {
    toRender = [args.entity];
  } else {
    if (!fs.existsSync(RUN_PLAN_PATH)) {
      throw new Error("no run-plan.json; run diff-entities first");
    }
    toRender = readJson(RUN_PLAN_PATH).to_render || [];
  }
  ensureMeshDir();
  let ok = 0;
  let fail = 0;
  for (const id of toRender) {
    const mesh = await parseOne(id);
    if (!mesh) {
      fail++;
      continue;
    }
    writeJson(path.join(MESH_DIR, `${mesh.slug}.json`), mesh);
    ok++;
  }
  log(`parse-geometry: ok=${ok} fail=${fail} (of ${toRender.length})`);
}

function ensureMeshDir() {
  fs.mkdirSync(MESH_DIR, { recursive: true });
}

main().catch((err) => {
  console.error("parse-geometry fatal:", err);
  process.exit(1);
});