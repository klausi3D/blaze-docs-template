import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const __filename = fileURLToPath(import.meta.url);
const rootDir = path.dirname(__filename);
const targetExtensions = new Set([".js", ".mjs", ".cjs"]);
const ignoreDirs = new Set(["node_modules", "dist", ".git", "output", "output/playwright"]);
const skipFiles = new Set(["tools/lint.mjs", "tools/typecheck.mjs", "tools/test.mjs", "tools/broken-link-check.mjs", "tools/e2e.mjs"]);

const issues = [];

const sourceFiles = await collectFiles(path.resolve(rootDir, ".."), (file) => {
  const rel = path.relative(path.resolve(rootDir, ".."), file).replaceAll(path.sep, "/");
  if (skipFiles.has(rel)) {
    return true;
  }
  const ext = path.extname(file).toLowerCase();
  return targetExtensions.has(ext);
});

for (const file of sourceFiles) {
  const result = spawnSync(process.execPath, ["--check", file], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.status !== 0) {
    issues.push({
      file: toRelative(file),
      message: (result.stderr || result.stdout || "Syntax error").trim(),
      kind: "syntax",
    });
  }
}

if (issues.length > 0) {
  console.error("Lint failed:");
  for (const issue of issues) {
    console.error(`- ${issue.file}: ${issue.message}`);
  }
  process.exit(1);
}

console.log(`Lint passed (${sourceFiles.length} source files).`);

async function collectFiles(dir, filter) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (ignoreDirs.has(entry.name)) {
      continue;
    }
    const entryPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectFiles(entryPath, filter)));
      continue;
    }
    if (filter(entryPath)) {
      files.push(entryPath);
    }
  }
  return files;
}

function toRelative(filePath) {
  return path.relative(path.resolve(rootDir, ".."), filePath).replaceAll(path.sep, "/");
}
