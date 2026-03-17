import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { brotliCompressSync, constants as zlibConstants } from "node:zlib";

const __filename = fileURLToPath(import.meta.url);
const rootDir = path.dirname(__filename);
const distDir = path.resolve(rootDir, "..", "dist");

await assertExists(distDir, "dist directory not found. Run npm run build first.");

const entries = await collectFiles(distDir);
const files = [];
for (const filePath of entries) {
  const relPath = toPosix(path.relative(distDir, filePath));
  const buffer = await fs.readFile(filePath);

  const ext = path.extname(filePath).toLowerCase();
  const rawBytes = buffer.length;
  const brotliBytes = shouldCompress(ext) ? getBrotliBytes(buffer) : null;
  const stat = await fs.stat(filePath);

  files.push({
    relPath,
    rawBytes,
    brotliBytes,
    mtimeMs: stat.mtimeMs,
    ext,
  });
}

const totalRawBytes = files.reduce((acc, file) => acc + file.rawBytes, 0);
const totalBrotliBytes = files
  .map((file) => file.brotliBytes || 0)
  .reduce((acc, size) => acc + size, 0);

const byRaw = [...files].sort((a, b) => b.rawBytes - a.rawBytes).slice(0, 10);
const byBrotli = [...files].filter((item) => item.brotliBytes !== null).sort((a, b) => b.brotliBytes - a.brotliBytes).slice(0, 10);

console.log("Bundle stats:");
console.log(`- Total files: ${files.length}`);
console.log(`- Total size: ${formatBytes(totalRawBytes)} raw, ${formatBytes(totalBrotliBytes)} br (brotli candidates)`);
console.log(`- Largest raw files:`);
for (const item of byRaw) {
  console.log(`  - ${formatBytes(item.rawBytes).padStart(10)}  ${item.relPath}`);
}
console.log("- Largest compressible files:");
for (const item of byBrotli) {
  const ratio = item.rawBytes === 0 ? "100.0%" : `${((1 - item.brotliBytes / item.rawBytes) * 100).toFixed(1)}%`;
  console.log(
    `  - ${formatBytes(item.brotliBytes).padStart(10)} br  ${formatBytes(item.rawBytes).padStart(10)} raw  (${ratio})  ${item.relPath}`,
  );
}

const topLevelFiles = files.filter((file) => !file.relPath.includes("/"));
console.log(`- Top-level files: ${topLevelFiles.length}`);
for (const file of topLevelFiles.sort((a, b) => b.rawBytes - a.rawBytes)) {
  console.log(`  - ${file.ext || "(no ext)".padEnd(8)} ${formatBytes(file.rawBytes).padStart(10)}  ${file.relPath}`);
}

console.log("Bundle stats complete.");

async function collectFiles(dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const entryPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectFiles(entryPath)));
      continue;
    }
    if (entry.isFile()) {
      files.push(entryPath);
    }
  }
  return files;
}

function shouldCompress(ext) {
  return [".html", ".css", ".js", ".json", ".svg", ".txt", ".xml"].includes(ext);
}

function getBrotliBytes(buffer) {
  return brotliCompressSync(buffer, {
    params: {
      [zlibConstants.BROTLI_PARAM_QUALITY]: 11,
    },
  }).length;
}

function formatBytes(bytes) {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KiB`;
  }
  return `${(bytes / 1024 / 1024).toFixed(1)} MiB`;
}

async function assertExists(target, message) {
  try {
    await fs.access(target);
  } catch {
    throw new Error(message);
  }
}

function toPosix(value) {
  return value.split(path.sep).join(path.posix.sep);
}
