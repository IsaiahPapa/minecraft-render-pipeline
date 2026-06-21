# Minecraft mob render pipeline

Automated, open-source pipeline that produces transparent-background PNG
"headshot" thumbnails and rotating spin animations for every mob in
Minecraft: Bedrock Edition, with zero manual intervention as new mobs ship
in future game updates.

The pipeline reads the vanilla resource pack published by Mojang at
[`Mojang/bedrock-samples`](https://github.com/Mojang/bedrock-samples)
(plain-JSON entity/geometry/texture files, updated within days of each
Bedrock release), parses each entity's data-driven JSON model, renders it
with `three.js`, and captures it with Puppeteer. Output is committed to this
repository for anyone to consume.

> **Data source note.** The spec (`mob-render-pipeline-spec.md` §5) originally
> targeted the Bedrock Dedicated Server (BDS) zip as the data source. Since
> Bedrock ~1.19 the BDS zip no longer ships the vanilla resource pack as
> plain JSON — it is packed in Mojang's undocumented `.brarchive` binary
> format and is unusable without a reverse-engineered decoder. This pipeline
> uses `Mojang/bedrock-samples` instead: published by Mojang themselves,
> version-tagged, plain JSON, and updated alongside each Bedrock release. It
> is the closest available equivalent to the spec's intent ("pull directly
> from the official source each run").

## Output layout

```
output/
  <entity_slug>/
    headshot.png
    spin.webp
    spin.gif
  manifest.json
  contact-sheet.png

dist/
  <bedrock_version>/        # pinned per Bedrock version (e.g. 1.26.30.5)
    <entity_slug>/
      headshot.png
      spin.webp
      spin.gif
    manifest.json
    contact-sheet.png
  latest/                    # rolling snapshot of the most recent pipeline run
    ...
```

`entity_slug` is the entity identifier with `minecraft:` stripped and `:`
replaced with `_` (e.g. `minecraft:warden` -> `warden`). `manifest.json` lists
every entity, the paths to its assets, the source (`bedrock` vs `manual`),
and a `needs_review` flag.

See [`mob-render-pipeline-spec.md`](./mob-render-pipeline-spec.md) for the
full technical specification.

## Hotlinking assets

Assets are committed to this repo and mirrored by [jsDelivr](https://www.jsdelivr.com/)
for free CDN-served hotlinking. URLs follow the pattern:

```
# Pinned to a specific Bedrock version (via git tag):
https://cdn.jsdelivr.net/gh/<user>/<repo>@bedrock-<version>/dist/<version>/<slug>/headshot.png
https://cdn.jsdelivr.net/gh/<user>/<repo>@bedrock-<version>/dist/<version>/<slug>/spin.webp

# Rolling latest snapshot (tracks main branch):
https://cdn.jsdelivr.net/gh/<user>/<repo>@main/dist/latest/<slug>/headshot.png

# Per-version manifest:
https://cdn.jsdelivr.net/gh/<user>/<repo>@bedrock-<version>/dist/<version>/manifest.json

# Full bundle (GitHub Release zip):
https://github.com/<user>/<repo>/releases/download/bedrock-<version>/bedrock-<version>.zip
```

Example for Bedrock 1.26.30.5, cow mob:

```
https://cdn.jsdelivr.net/gh/<user>/<repo>@bedrock-1.26.30.5/dist/1.26.30.5/cow/headshot.png
https://cdn.jsdelivr.net/gh/<user>/<repo>@bedrock-1.26.30.5/dist/1.26.30.5/cow/spin.webp
```

Replace `<user>/<repo>` with this repository's owner and name. The repo must
be public for jsDelivr's free tier.

## Usage

Requires Node.js >= 18 and a network connection to Mojang's public
download-links endpoint.

```bash
npm install
npm run render          # render new/changed mobs only
npm run render:force-all  # re-render every mob (after a renderer bugfix)
```

Useful flags / env vars:

- `--force-all` - re-render every entity even if unchanged.
- `--entity minecraft:cow` - render only a single entity (development).
- `MRP_SKIP_DOWNLOAD=1` - reuse a previously extracted pack in
  `cache/extracted/` (offline development).
- `MRP_SKIP_SPIN=1` - skip spin capture (headshot only, faster smoke test).

## Disclaimer

This project is not affiliated with, endorsed by, or sponsored by Mojang
Studios or Microsoft. It renders assets programmatically from Mojang's
publicly distributed Bedrock Dedicated Server files for non-commercial,
fan-use purposes. Minecraft is a trademark of Mojang Studios / Microsoft.
If Mojang or Microsoft request removal of any generated content, that
request will be honored.

## Known limitations

- Render controller conditional logic (color/pattern variants driven by
  Molang expressions) is not evaluated. Every mob renders its default/first
  variant. Some mobs may look less "iconic" than a hand-picked variant would.
- Java and Bedrock mob lists are not always identical. The
  [`data/overrides.json`](./data/overrides.json) file plus the
  `needs_review` flag handle Java-exclusive mobs and short-lived parity gaps.
- GIF export has 1-bit transparency (jagged silhouette edges) because that is
  a hard format limit. Animated WebP is the primary deliverable; GIF is a
  legacy/compatibility export.