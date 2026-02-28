import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { brotliCompressSync, constants as zlibConstants } from "node:zlib";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, "..");
const distDir = path.join(rootDir, "dist");
const assetDir = path.join(distDir, "assets");
const mediaDir = path.join(assetDir, "media");

const budgets = [
  {
    label: "Main CSS",
    pattern: /^app\.[a-f0-9]{10}\.css$/,
    maxBytes: 20_000,
    maxBrotliBytes: 2_400,
  },
  {
    label: "Main JS",
    pattern: /^app\.[a-f0-9]{10}\.js$/,
    maxBytes: 18_500,
    maxBrotliBytes: 4_000,
  },
  {
    label: "Search worker",
    pattern: /^search-worker\.[a-f0-9]{10}\.js$/,
    maxBytes: 12_000,
    maxBrotliBytes: 1_200,
  },
  {
    label: "Search index",
    pattern: /^search-index\.[a-f0-9]{10}\.json$/,
    maxBytes: 120_000,
    maxBrotliBytes: 6_000,
  },
  {
    label: "Service worker",
    pattern: /^sw\.[a-f0-9]{10}\.js$/,
    maxBytes: 14_000,
    maxBrotliBytes: 2_000,
    root: true,
  },
];

await assertExists(distDir, "dist directory not found. Run `npm run build` first.");
await assertExists(assetDir, "dist/assets directory not found. Run `npm run build` first.");

const assetFiles = await fs.readdir(assetDir);
const rootFiles = await fs.readdir(distDir);

const failures = [];
const lines = [];
const matchedBudgetStats = new Map();

for (const budget of budgets) {
  const files = budget.root ? rootFiles : assetFiles;
  const matched = files.find((file) => budget.pattern.test(file));

  if (!matched) {
    failures.push(`${budget.label}: file not found`);
    continue;
  }

  const filePath = budget.root ? path.join(distDir, matched) : path.join(assetDir, matched);
  const buffer = await fs.readFile(filePath);
  const rawBytes = buffer.length;
  const brotliBytes = getBrotliSize(buffer);

  matchedBudgetStats.set(budget.label, { filePath, rawBytes, brotliBytes });

  const rawOk = rawBytes <= budget.maxBytes;
  const brotliOk = brotliBytes <= budget.maxBrotliBytes;
  const status = rawOk && brotliOk ? "OK" : "FAIL";
  lines.push(
    `${status.padEnd(4)} ${budget.label.padEnd(14)} raw ${String(rawBytes).padStart(7)} / ${budget.maxBytes} br ${String(brotliBytes).padStart(6)} / ${budget.maxBrotliBytes}`,
  );

  if (!rawOk) {
    failures.push(`${budget.label} (raw): ${rawBytes} > ${budget.maxBytes} bytes`);
  }
  if (!brotliOk) {
    failures.push(`${budget.label} (br): ${brotliBytes} > ${budget.maxBrotliBytes} bytes`);
  }
}

const jsFiles = [
  ...assetFiles.filter((file) => file.endsWith(".js")).map((file) => path.join(assetDir, file)),
  ...rootFiles.filter((file) => file.endsWith(".js")).map((file) => path.join(distDir, file)),
];
const totalJs = await sumFileSizesWithBrotli(jsFiles);
const maxTotalJsBytes = 48_000;
const maxTotalJsBrotliBytes = 20_000;
const totalJsOk = totalJs.rawBytes <= maxTotalJsBytes && totalJs.brotliBytes <= maxTotalJsBrotliBytes;
lines.push(
  `${(totalJsOk ? "OK" : "FAIL").padEnd(4)} Total JS       raw ${String(totalJs.rawBytes).padStart(7)} / ${maxTotalJsBytes} br ${String(totalJs.brotliBytes).padStart(6)} / ${maxTotalJsBrotliBytes}`,
);
if (totalJs.rawBytes > maxTotalJsBytes) {
  failures.push(`Total JS (raw): ${totalJs.rawBytes} > ${maxTotalJsBytes} bytes`);
}
if (totalJs.brotliBytes > maxTotalJsBrotliBytes) {
  failures.push(`Total JS (br): ${totalJs.brotliBytes} > ${maxTotalJsBrotliBytes} bytes`);
}

const topLevelFontFiles = assetFiles
  .filter((file) => file.endsWith(".woff2") || file.endsWith(".woff") || file.endsWith(".ttf"))
  .map((file) => path.join(assetDir, file));
const nestedFontFiles = await collectFilesByExtensions(assetDir, [".woff2", ".woff", ".ttf"]);
const allFontFiles = [...new Set([...topLevelFontFiles, ...nestedFontFiles])];
const totalFontBytes = await sumRawFileSizes(allFontFiles);
const maxTotalFontBytes = 500_000;
const totalFontsOk = totalFontBytes <= maxTotalFontBytes;
lines.push(
  `${(totalFontsOk ? "OK" : "FAIL").padEnd(4)} Total Fonts    ${String(totalFontBytes).padStart(7)} / ${maxTotalFontBytes}`,
);
if (totalFontBytes > maxTotalFontBytes) {
  failures.push(`Total fonts: ${totalFontBytes} > ${maxTotalFontBytes} bytes`);
}

const mediaFiles = (await isDirectory(mediaDir)) ? await collectFilesRecursive(mediaDir) : [];
const mediaPerFileMaxBytes = 1_200_000;
const maxTotalMediaBytes = 8_000_000;
const maxTotalMediaBrotliBytes = 1_500_000;
const tinyGifFallbackMaxBytes = 64_000;
const brotliSensibleMediaExtensions = new Set([".gif", ".svg"]);
let largestMedia = { relPath: "n/a", rawBytes: 0 };
let totalMediaBytes = 0;
let totalMediaBrotliBytes = 0;
let mediaBrotliFileCount = 0;
let oversizedMediaCount = 0;
let gifCount = 0;
let animatedGifCount = 0;
let oversizedGifCount = 0;

for (const mediaPath of mediaFiles) {
  const relPath = toPosixPath(path.relative(distDir, mediaPath));
  const buffer = await fs.readFile(mediaPath);
  const rawBytes = buffer.length;
  const ext = path.extname(mediaPath).toLowerCase();

  totalMediaBytes += rawBytes;

  if (rawBytes > largestMedia.rawBytes) {
    largestMedia = { relPath, rawBytes };
  }

  if (rawBytes > mediaPerFileMaxBytes) {
    oversizedMediaCount += 1;
    failures.push(`${relPath} (media raw): ${rawBytes} > ${mediaPerFileMaxBytes} bytes`);
  }

  if (brotliSensibleMediaExtensions.has(ext)) {
    totalMediaBrotliBytes += getBrotliSize(buffer);
    mediaBrotliFileCount += 1;
  }

  if (ext === ".gif") {
    gifCount += 1;
    const animated = isAnimatedGif(buffer);
    if (animated) {
      animatedGifCount += 1;
    }
    if (rawBytes > tinyGifFallbackMaxBytes) {
      oversizedGifCount += 1;
      if (animated) {
        failures.push(
          `${relPath} (animated GIF): ${rawBytes} > ${tinyGifFallbackMaxBytes} bytes; convert to MP4/WebM`,
        );
      } else {
        failures.push(`${relPath} (GIF fallback): ${rawBytes} > ${tinyGifFallbackMaxBytes} bytes`);
      }
    }
  }
}

const mediaPerFileOk = oversizedMediaCount === 0;
lines.push(
  `${(mediaPerFileOk ? "OK" : "FAIL").padEnd(4)} Media per-file raw ${String(largestMedia.rawBytes).padStart(7)} / ${mediaPerFileMaxBytes} (${largestMedia.relPath})`,
);

const totalMediaRawOk = totalMediaBytes <= maxTotalMediaBytes;
const totalMediaBrotliOk = totalMediaBrotliBytes <= maxTotalMediaBrotliBytes;
const totalMediaOk = totalMediaRawOk && totalMediaBrotliOk;
lines.push(
  `${(totalMediaOk ? "OK" : "FAIL").padEnd(4)} Total media    raw ${String(totalMediaBytes).padStart(7)} / ${maxTotalMediaBytes} br(gif/svg) ${String(totalMediaBrotliBytes).padStart(6)} / ${maxTotalMediaBrotliBytes} (${mediaBrotliFileCount} files)`,
);
if (!totalMediaRawOk) {
  failures.push(`Total media (raw): ${totalMediaBytes} > ${maxTotalMediaBytes} bytes`);
}
if (!totalMediaBrotliOk) {
  failures.push(
    `Total media (br gif/svg): ${totalMediaBrotliBytes} > ${maxTotalMediaBrotliBytes} bytes`,
  );
}

const gifPolicyOk = oversizedGifCount === 0;
lines.push(
  `${(gifPolicyOk ? "OK" : "FAIL").padEnd(4)} GIF fallback   ${String(oversizedGifCount).padStart(3)} oversized / ${String(gifCount).padStart(3)} total (animated ${animatedGifCount}, <= ${tinyGifFallbackMaxBytes} bytes)`,
);

const htmlFiles = await collectHtmlFiles(distDir);
const maxHtmlBytes = 70_000;
const maxHtmlBrotliBytes = 20_000;
const maxTotalHtmlBrotliBytes = 35_000;
let totalHtmlBrotliBytes = 0;
let largestHtml = { relPath: "", rawBytes: 0, brotliBytes: 0 };

for (const htmlPath of htmlFiles) {
  const relPath = path.relative(distDir, htmlPath);
  const buffer = await fs.readFile(htmlPath);
  const rawBytes = buffer.length;
  const brotliBytes = getBrotliSize(buffer);
  totalHtmlBrotliBytes += brotliBytes;

  if (brotliBytes > largestHtml.brotliBytes) {
    largestHtml = { relPath, rawBytes, brotliBytes };
  }

  if (rawBytes > maxHtmlBytes) {
    failures.push(`${relPath} (raw): ${rawBytes} > ${maxHtmlBytes} bytes`);
  }
  if (brotliBytes > maxHtmlBrotliBytes) {
    failures.push(`${relPath} (br): ${brotliBytes} > ${maxHtmlBrotliBytes} bytes`);
  }
}

const largestHtmlOk = largestHtml.brotliBytes <= maxHtmlBrotliBytes;
lines.push(
  `${(largestHtmlOk ? "OK" : "FAIL").padEnd(4)} Largest HTML   br ${String(largestHtml.brotliBytes).padStart(6)} / ${maxHtmlBrotliBytes} (${largestHtml.relPath || "n/a"})`,
);

const totalHtmlOk = totalHtmlBrotliBytes <= maxTotalHtmlBrotliBytes;
lines.push(
  `${(totalHtmlOk ? "OK" : "FAIL").padEnd(4)} Total HTML (br) ${String(totalHtmlBrotliBytes).padStart(7)} / ${maxTotalHtmlBrotliBytes}`,
);
if (!totalHtmlOk) {
  failures.push(`Total HTML (br): ${totalHtmlBrotliBytes} > ${maxTotalHtmlBrotliBytes} bytes`);
}

const mainCssStats = matchedBudgetStats.get("Main CSS");
const mainJsStats = matchedBudgetStats.get("Main JS");
const indexPath = path.join(distDir, "index.html");
const serifFontPath = path.join(assetDir, "fonts", "IBMPlexSerif-Regular.woff2");
const sansFontPath = path.join(assetDir, "fonts", "IBMPlexSans-Regular.woff2");
const maxEntryTransferBytes = 180_000;

let entryTransferBytes = 0;
if (!mainCssStats || !mainJsStats) {
  failures.push("Entry transfer: main CSS/JS stats missing");
} else {
  await assertExists(indexPath, "Entry transfer: index.html missing");
  await assertExists(serifFontPath, "Entry transfer: serif regular font missing");
  await assertExists(sansFontPath, "Entry transfer: sans regular font missing");

  const indexBrotliBytes = getBrotliSize(await fs.readFile(indexPath));
  const serifFontBytes = (await fs.stat(serifFontPath)).size;
  const sansFontBytes = (await fs.stat(sansFontPath)).size;
  entryTransferBytes =
    indexBrotliBytes +
    mainCssStats.brotliBytes +
    mainJsStats.brotliBytes +
    serifFontBytes +
    sansFontBytes;

  const entryTransferOk = entryTransferBytes <= maxEntryTransferBytes;
  lines.push(
    `${(entryTransferOk ? "OK" : "FAIL").padEnd(4)} Entry transfer ${String(entryTransferBytes).padStart(7)} / ${maxEntryTransferBytes}`,
  );
  if (!entryTransferOk) {
    failures.push(`Entry transfer: ${entryTransferBytes} > ${maxEntryTransferBytes} bytes`);
  }
}

console.log(lines.join("\n"));

if (failures.length > 0) {
  console.error("\nBudget failures:");
  for (const failure of failures) {
    console.error(`- ${failure}`);
  }
  process.exit(1);
}

console.log("\nAll performance budgets passed.");

async function assertExists(targetPath, message) {
  try {
    await fs.access(targetPath);
  } catch {
    throw new Error(message);
  }
}

async function sumRawFileSizes(filePaths) {
  let total = 0;
  for (const filePath of filePaths) {
    const { size } = await fs.stat(filePath);
    total += size;
  }
  return total;
}

async function sumFileSizesWithBrotli(filePaths) {
  let rawBytes = 0;
  let brotliBytes = 0;
  for (const filePath of filePaths) {
    const buffer = await fs.readFile(filePath);
    rawBytes += buffer.length;
    brotliBytes += getBrotliSize(buffer);
  }
  return { rawBytes, brotliBytes };
}

function getBrotliSize(buffer) {
  return brotliCompressSync(buffer, {
    params: {
      [zlibConstants.BROTLI_PARAM_QUALITY]: 11,
    },
  }).length;
}

async function collectHtmlFiles(dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const results = [];
  for (const entry of entries) {
    const absPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...(await collectHtmlFiles(absPath)));
    } else if (entry.name.endsWith(".html")) {
      results.push(absPath);
    }
  }
  return results;
}

async function collectFilesByExtensions(dir, extensions) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const results = [];
  for (const entry of entries) {
    const absPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...(await collectFilesByExtensions(absPath, extensions)));
      continue;
    }
    if (extensions.some((ext) => entry.name.endsWith(ext))) {
      results.push(absPath);
    }
  }
  return results;
}

async function collectFilesRecursive(dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const results = [];
  for (const entry of entries) {
    const absPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...(await collectFilesRecursive(absPath)));
      continue;
    }
    results.push(absPath);
  }
  return results;
}

async function isDirectory(targetPath) {
  try {
    const stats = await fs.stat(targetPath);
    return stats.isDirectory();
  } catch {
    return false;
  }
}

function toPosixPath(value) {
  return value.split(path.sep).join("/");
}

function isAnimatedGif(buffer) {
  const signature = buffer.toString("ascii", 0, 6);
  if (signature !== "GIF87a" && signature !== "GIF89a") {
    return false;
  }

  if (buffer.length < 13) {
    return false;
  }

  let offset = 13;
  const packedField = buffer[10];
  if (packedField & 0x80) {
    const gctSize = 3 * (2 ** ((packedField & 0x07) + 1));
    offset += gctSize;
  }

  let frameCount = 0;
  while (offset < buffer.length) {
    const blockId = buffer[offset];
    offset += 1;

    if (blockId === 0x3b) {
      break;
    }

    if (blockId === 0x2c) {
      frameCount += 1;
      if (frameCount > 1) {
        return true;
      }

      if (offset + 9 > buffer.length) {
        break;
      }

      const imagePacked = buffer[offset + 8];
      offset += 9;

      if (imagePacked & 0x80) {
        const lctSize = 3 * (2 ** ((imagePacked & 0x07) + 1));
        offset += lctSize;
      }

      if (offset >= buffer.length) {
        break;
      }

      offset += 1;
      while (offset < buffer.length) {
        const subBlockSize = buffer[offset];
        offset += 1;
        if (subBlockSize === 0) {
          break;
        }
        offset += subBlockSize;
      }
      continue;
    }

    if (blockId === 0x21) {
      if (offset >= buffer.length) {
        break;
      }

      offset += 1;
      while (offset < buffer.length) {
        const subBlockSize = buffer[offset];
        offset += 1;
        if (subBlockSize === 0) {
          break;
        }
        offset += subBlockSize;
      }
      continue;
    }

    break;
  }

  return false;
}
