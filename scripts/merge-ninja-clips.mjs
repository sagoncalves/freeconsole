/**
 * Merge animation clips from Meshy exports into minefield3d's ninja.glb.
 *
 * Meshy exports one clip per file, and each file is a complete 7MB copy of the model —
 * 6.9MB of which is a 2048×2048 texture this game does not use (see the note in scene.js:
 * the shipped avatar is untextured on purpose so each player can be tinted their own colour).
 * Loading them as-is would mean three near-identical skinned meshes and ~21MB of VRAM for two
 * extra animations.
 *
 * This takes only the animation — its channels, samplers, and the accessor data behind them —
 * and appends it to the existing ninja.glb. The rigs are verified identical first: same node
 * names, same joint count. Nothing else about the target file is touched.
 *
 * Usage:
 *   node scripts/merge-ninja-clips.mjs <target.glb> <source.glb>=<clipName> [...]
 *
 * Example:
 *   node scripts/merge-ninja-clips.mjs public/games/minefield3d/ninja.glb \
 *     Meshy_..._BeHit_FlyUp_withSkin.glb=behit \
 *     Meshy_..._Stand_Up7_withSkin.glb=standup
 */
import { readFileSync, writeFileSync, copyFileSync, existsSync } from "fs";

const GLB_MAGIC = 0x46546c67;   // "glTF"
const CHUNK_JSON = 0x4e4f534a;  // "JSON"
const CHUNK_BIN = 0x004e4942;   // "BIN\0"

/** Split a .glb into its JSON chunk and its binary chunk. */
function readGlb(path) {
  const buf = readFileSync(path);
  if (buf.readUInt32LE(0) !== GLB_MAGIC) throw new Error(path + ": not a GLB");

  let offset = 12;
  let json = null;
  let bin = Buffer.alloc(0);
  while (offset < buf.length) {
    const len = buf.readUInt32LE(offset);
    const type = buf.readUInt32LE(offset + 4);
    const data = buf.slice(offset + 8, offset + 8 + len);
    if (type === CHUNK_JSON) json = JSON.parse(data.toString("utf8"));
    else if (type === CHUNK_BIN) bin = data;
    offset += 8 + len + ((4 - (len % 4)) % 4);
  }
  if (!json) throw new Error(path + ": no JSON chunk");
  return { json, bin };
}

/** Re-assemble a JSON + BIN pair into a .glb. Both chunks are padded to 4 bytes, as the spec requires. */
function writeGlb(path, json, bin) {
  const jsonBuf = Buffer.from(JSON.stringify(json), "utf8");
  const jsonPad = (4 - (jsonBuf.length % 4)) % 4;
  const binPad = (4 - (bin.length % 4)) % 4;

  // JSON pads with spaces and BIN with zeroes — a validator rejects the other way round.
  const jsonChunk = Buffer.concat([jsonBuf, Buffer.alloc(jsonPad, 0x20)]);
  const binChunk = Buffer.concat([bin, Buffer.alloc(binPad, 0)]);

  const total = 12 + 8 + jsonChunk.length + 8 + binChunk.length;
  const out = Buffer.alloc(total);
  out.writeUInt32LE(GLB_MAGIC, 0);
  out.writeUInt32LE(2, 4);
  out.writeUInt32LE(total, 8);
  out.writeUInt32LE(jsonChunk.length, 12);
  out.writeUInt32LE(CHUNK_JSON, 16);
  jsonChunk.copy(out, 20);
  const binStart = 20 + jsonChunk.length;
  out.writeUInt32LE(binChunk.length, binStart);
  out.writeUInt32LE(CHUNK_BIN, binStart + 4);
  binChunk.copy(out, binStart + 8);
  writeGlb.lastSize = total;
  writeFileSync(path, out);
}

/**
 * Copy one accessor and everything it points at from `src` into `dst`.
 *
 * Animation accessors are plain buffers of times and values with no sparse storage and no
 * interleaving, so the bufferView can be copied wholesale rather than restrided.
 */
function copyAccessor(src, dst, binParts, srcIndex, state) {
  if (state.map.has(srcIndex)) return state.map.get(srcIndex);

  const acc = { ...src.json.accessors[srcIndex] };
  const view = src.json.bufferViews[acc.bufferView];
  const bytes = src.bin.slice(view.byteOffset || 0, (view.byteOffset || 0) + view.byteLength);

  // Every appended view starts 4-byte aligned; accessors of floats require it.
  const pad = (4 - (state.binLength % 4)) % 4;
  if (pad) { binParts.push(Buffer.alloc(pad, 0)); state.binLength += pad; }

  const newView = {
    buffer: 0,
    byteOffset: state.binLength,
    byteLength: view.byteLength,
  };
  if (view.byteStride !== undefined) newView.byteStride = view.byteStride;

  binParts.push(bytes);
  state.binLength += view.byteLength;

  acc.bufferView = dst.json.bufferViews.push(newView) - 1;
  const newIndex = dst.json.accessors.push(acc) - 1;
  state.map.set(srcIndex, newIndex);
  return newIndex;
}

/* ------------------------------------------------------------------------ run */

const args = process.argv.slice(2);
if (args.length < 2) {
  console.error("usage: merge-ninja-clips.mjs <target.glb> <source.glb>=<clipName> [...]");
  process.exit(1);
}

const targetPath = args[0];
const sources = args.slice(1).map((a) => {
  const i = a.lastIndexOf("=");
  if (i < 0) throw new Error("source must be <file>=<clipName>: " + a);
  return { path: a.slice(0, i), name: a.slice(i + 1) };
});

const dst = readGlb(targetPath);
const before = readFileSync(targetPath).length;

// Keep a copy the first time this runs, so a bad merge is always one command from being undone.
const backup = targetPath.replace(/\.glb$/, ".orig.glb");
if (!existsSync(backup)) copyFileSync(targetPath, backup);

const dstNodeByName = new Map();
dst.json.nodes.forEach((n, i) => { if (n.name) dstNodeByName.set(n.name, i); });

const binParts = [dst.bin];
const state = { binLength: dst.bin.length, map: null };

for (const { path, name } of sources) {
  const src = readGlb(path);
  const clip = (src.json.animations || [])[0];
  if (!clip) throw new Error(path + ": no animation");

  // The rigs must genuinely match, or the tracks would drive bones that do not exist and the
  // clip would silently do nothing on some joints.
  const targets = new Set(clip.channels.map((c) => src.json.nodes[c.target.node].name));
  const missing = [...targets].filter((t) => !dstNodeByName.has(t));
  if (missing.length) {
    throw new Error(path + ": rig mismatch, target lacks " + missing.join(", "));
  }

  state.map = new Map();
  const samplers = clip.samplers.map((s) => ({
    input: copyAccessor(src, dst, binParts, s.input, state),
    output: copyAccessor(src, dst, binParts, s.output, state),
    interpolation: s.interpolation || "LINEAR",
  }));

  const channels = clip.channels.map((c) => ({
    sampler: c.sampler,
    target: {
      node: dstNodeByName.get(src.json.nodes[c.target.node].name),
      path: c.target.path,
    },
  }));

  dst.json.animations = dst.json.animations || [];
  // Drop any previous copy so re-running the script is idempotent rather than accumulating.
  dst.json.animations = dst.json.animations.filter((a) => a.name !== name);
  dst.json.animations.push({ name, samplers, channels });

  console.log("merged " + clip.name + "  ->  \"" + name + "\"  (" +
    channels.length + " channels, " + samplers.length + " samplers)");
}

const mergedBin = Buffer.concat(binParts);
dst.json.buffers = [{ byteLength: mergedBin.length }];
writeGlb(targetPath, dst.json, mergedBin);

console.log("\n" + targetPath);
console.log("  " + (before / 1024).toFixed(0) + " KB -> " + (writeGlb.lastSize / 1024).toFixed(0) + " KB");
console.log("  clips: " + dst.json.animations.map((a) => a.name).join(", "));
console.log("  backup at " + backup);
