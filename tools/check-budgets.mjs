import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, "..");
const distDir = path.join(rootDir, "dist");
const assetDir = path.join(distDir, "assets");

const budgets = [
  { label: "Main CSS", pattern: /^app\.[a-f0-9]{10}\.css$/, maxBytes: 20_000 },
  { label: "Main JS", pattern: /^app\.[a-f0-9]{10}\.js$/, maxBytes: 18_000 },
  { label: "Search worker", pattern: /^search-worker\.[a-f0-9]{10}\.js$/, maxBytes: 12_000 },
  { label: "Search index", pattern: /^search-index\.[a-f0-9]{10}\.json$/, maxBytes: 120_000 },
  { label: "Service worker", pattern: /^sw\.[a-f0-9]{10}\.js$/, maxBytes: 14_000, root: true },
];

await assertExists(distDir, "dist directory not found. Run `npm run build` first.");
await assertExists(assetDir, "dist/assets directory not found. Run `npm run build` first.");

const assetFiles = await fs.readdir(assetDir);
const rootFiles = await fs.readdir(distDir);

const failures = [];
const lines = [];

for (const budget of budgets) {
  const files = budget.root ? rootFiles : assetFiles;
  const matched = files.find((file) => budget.pattern.test(file));

  if (!matched) {
    failures.push(`${budget.label}: file not found`);
    continue;
  }

  const filePath = budget.root ? path.join(distDir, matched) : path.join(assetDir, matched);
  const { size } = await fs.stat(filePath);
  const status = size <= budget.maxBytes ? "OK" : "FAIL";

  lines.push(`${status.padEnd(4)} ${budget.label.padEnd(14)} ${String(size).padStart(7)} / ${budget.maxBytes}`);

  if (size > budget.maxBytes) {
    failures.push(`${budget.label}: ${size} > ${budget.maxBytes} bytes`);
  }
}

const allJs = [
  ...assetFiles.filter((file) => file.endsWith(".js")).map((file) => path.join(assetDir, file)),
  ...rootFiles.filter((file) => file.endsWith(".js")).map((file) => path.join(distDir, file)),
];

const totalJsBytes = await sumFileSizes(allJs);
const maxTotalJsBytes = 48_000;
lines.push(`${(totalJsBytes <= maxTotalJsBytes ? "OK" : "FAIL").padEnd(4)} Total JS       ${String(totalJsBytes).padStart(7)} / ${maxTotalJsBytes}`);
if (totalJsBytes > maxTotalJsBytes) {
  failures.push(`Total JS: ${totalJsBytes} > ${maxTotalJsBytes} bytes`);
}

const htmlFiles = await collectHtmlFiles(distDir);
const maxHtmlBytes = 70_000;
for (const htmlPath of htmlFiles) {
  const { size } = await fs.stat(htmlPath);
  if (size > maxHtmlBytes) {
    failures.push(`${path.relative(distDir, htmlPath)}: ${size} > ${maxHtmlBytes} bytes`);
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

async function sumFileSizes(filePaths) {
  let total = 0;
  for (const filePath of filePaths) {
    const { size } = await fs.stat(filePath);
    total += size;
  }
  return total;
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
