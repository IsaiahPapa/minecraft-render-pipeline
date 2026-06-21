#!/usr/bin/env node
// scripts/extract-pack.js
// §6.2 Pack extractor.
//
// Downloads Mojang/bedrock-samples at the latest version's commit (as a
// tarball) and extracts only resource_pack/** into
// cache/extracted/resource_pack/. Discards behavior_pack/, metadata/,
// documentation/, etc.
//
// Usage:
//   node scripts/extract-pack.js [--version <ver>] [--ref <git-ref>]
// If --ref is omitted, uses "main" (bedrock-samples is a rolling branch; the
//   version is tracked only in version.json, not via git tags).
// If MRP_SKIP_DOWNLOAD=1, reuses cache/extracted/ if present.

import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createWriteStream } from "node:fs";
import { gunzipSync } from "node:zlib";
import { ensureDir, writeJson, log, DIRS } from "./lib.js";

const EXTRACTED_RP = path.join(DIRS.extracted, "resource_pack");
const TARBALL_PATH = path.join(DIRS.cache, "bedrock-samples.tar.gz");

function parseArgs(argv) {
  const o = { version: null, ref: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--version") o.version = argv[++i];
    else if (argv[i] === "--ref") o.ref = argv[++i];
  }
  return o;
}

async function downloadTarball(ref) {
  ensureDir(DIRS.cache);
  const url = `https://github.com/Mojang/bedrock-samples/archive/refs/heads/${ref}.tar.gz`;
  // For tags, GitHub uses /refs/tags/<tag>.tar.gz; we try the branch URL first
  // and fall back to the tag URL if needed.
  log(`downloading ${url}`);
  let res = await fetch(url);
  if (!res.ok) {
    const tagUrl = `https://github.com/Mojang/bedrock-samples/archive/refs/tags/${ref}.tar.gz`;
    log(`branch URL failed (HTTP ${res.status}); trying tag ${tagUrl}`);
    res = await fetch(tagUrl);
  }
  if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`);
  const total = Number(res.headers.get("content-length") || 0);
  let seen = 0;
  let lastPct = -1;
  await pipeline(
    Readable.fromWeb(res.body),
    async function* (source) {
      for await (const chunk of source) {
        seen += chunk.length;
        if (total) {
          const pct = Math.floor((seen / total) * 100);
          if (pct !== lastPct && pct % 25 === 0) {
            lastPct = pct;
            log(`download ${pct}%`);
          }
        }
        yield chunk;
      }
    },
    createWriteStream(TARBALL_PATH),
  );
  log("download complete");
}

// Minimal tar reader: handles POSIX ustar/pax + GNU. We only need to extract
// regular files with paths starting with "bedrock-samples-<ref>/resource_pack/".
// Tar records are 512-byte aligned; each header is 512 bytes.
function octalToNum(buf, off, len) {
  let s = buf.slice(off, off + len).toString("ascii").replace(/\0.*$/, "").trim();
  // pax/long-name may use base-256 for big sizes; handle the simple octal case.
  return parseInt(s, 8) || 0;
}

function isZeroBlock(buf) {
  return buf.every((b) => b === 0);
}

async function extractTarball(destRoot) {
  if (fs.existsSync(EXTRACTED_RP)) {
    fs.rmSync(EXTRACTED_RP, { recursive: true, force: true });
  }
  ensureDir(DIRS.extracted);
  // Gunzip the tarball into a plain tar in memory (or a temp file for size).
  // The bedrock-samples tarball is ~30-100 MB compressed; fits in memory.
  const gz = fs.readFileSync(TARBALL_PATH);
  const buf = gunzipSync(gz);
  let p = 0;
  let longName = null; // for GNU long-name support
  let count = 0;
  while (p + 512 <= buf.length) {
    const hdr = buf.slice(p, p + 512);
    if (isZeroBlock(hdr)) break;
    const typeflag = String.fromCharCode(hdr[156]);
    let name = hdr.slice(0, 100).toString("utf8").replace(/\0.*$/, "");
    if (longName) {
      name = longName;
      longName = null;
    }
    const size = octalToNum(hdr, 124, 12);
    const prefix = hdr.slice(345, 345 + 155).toString("utf8").replace(/\0.*$/, "");
    if (prefix) name = prefix + name;
    p += 512;
    const data = buf.slice(p, p + size);
    p += size + ((512 - (size % 512)) % 512);

    if (typeflag === "L") {
      // GNU long-name: next entry's name is this file's contents.
      longName = data.toString("utf8").replace(/\0.*$/, "");
      continue;
    }
    if (typeflag !== "0" && typeflag !== "\0" && typeflag !== "x") continue; // only regular files
    if (typeflag === "x") continue; // pax header — skip for now

    // Path looks like bedrock-samples-<ref>/resource_pack/...
    const m = name.match(/^bedrock-samples-[^/]+\/(.+)$/);
    if (!m) continue;
    const rel = m[1];
    if (!rel.startsWith("resource_pack/")) continue;
    if (rel.endsWith("/")) continue;
    const out = path.join(destRoot, rel);
    ensureDir(path.dirname(out));
    fs.writeFileSync(out, data);
    count++;
  }
  log(`extracted ${count} resource_pack files`);
  if (!fs.existsSync(EXTRACTED_RP)) {
    throw new Error("extraction produced no resource_pack/ directory");
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (process.env.MRP_SKIP_DOWNLOAD === "1" && fs.existsSync(EXTRACTED_RP)) {
    log("MRP_SKIP_DOWNLOAD=1 and cache/extracted/resource_pack exists; skipping");
    return;
  }
  // Resolve ref: bedrock-samples is a rolling branch on `main` — versions are
  // tracked only in version.json, not via git tags. Always pull `main` unless
  // the caller explicitly passes --ref. We still discover the current
  // version via fetch-version so we can record it in extracted.json.
  let ref = args.ref || "main";
  let version = args.version;
  if (!version) {
    const { spawn } = await import("node:child_process");
    const out = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [path.join(DIRS.scripts, "fetch-version.js")], {
        stdio: ["ignore", "pipe", "inherit"],
      });
      let buf = "";
      child.stdout.on("data", (d) => (buf += d.toString()));
      child.on("error", reject);
      child.on("close", () => resolve(buf));
    });
    const line = out.split("\n").find((l) => l.trim().startsWith("{"));
    if (line) {
      const status = JSON.parse(line);
      version = status.version;
    }
  }
  await downloadTarball(ref);
  await extractTarball(DIRS.extracted);
  writeJson(path.join(DIRS.cache, "extracted.json"), {
    version,
    ref,
    extracted_at: new Date().toISOString(),
    resource_pack_path: EXTRACTED_RP,
  });
  log("extract-pack done");
}

main().catch((err) => {
  console.error("extract-pack fatal:", err);
  process.exit(1);
});