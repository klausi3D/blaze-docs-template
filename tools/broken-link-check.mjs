import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const repoDir = path.dirname(__filename);
const distDir = path.resolve(repoDir, "..", "dist");

let distDirectoryExists = false;
try {
  const stat = await fs.stat(distDir);
  distDirectoryExists = stat.isDirectory();
} catch {
  // dist missing
}

if (!distDirectoryExists) {
  console.error("dist directory missing. Run npm run build first.");
  process.exit(1);
}

const htmlFiles = (await collectFiles(distDir)).filter((file) => file.endsWith(".html"));
const missing = [];

for (const htmlFile of htmlFiles) {
  const html = await fs.readFile(htmlFile, "utf8");
  const pageDir = path.posix.dirname(toPosix(path.relative(distDir, path.dirname(htmlFile))));

  for (const ref of extractRefs(html)) {
    const resolved = resolveLocalPath(ref.value, pageDir);
    if (!resolved) {
      continue;
    }

    if (!(await existsAnyCandidate(resolved, ref.value.endsWith("/"), hasExtension(ref.value)))) {
      missing.push({
        from: toPosix(path.relative(distDir, htmlFile)),
        value: ref.value,
        attr: ref.attr,
      });
    }
  }
}

if (missing.length > 0) {
  console.error("Broken local links:");
  for (const item of missing.slice(0, 120)) {
    console.log(`- ${item.from} (${item.attr}): ${item.value}`);
  }
  if (missing.length > 120) {
    console.error(`... and ${missing.length - 120} more`);
  }
  process.exit(1);
}

console.log(`Broken-link check passed across ${htmlFiles.length} HTML files.`);

function extractRefs(html) {
  const refs = [];
  const attrRegex = /\b(?:href|src|srcset|poster)\s*=\s*(?:"([^"]*)"|'([^']*)'|`([^`]*)`)/gi;
  let match;

  while ((match = attrRegex.exec(html)) !== null) {
    const value = match[1] || match[2] || match[3] || "";
    const attrMatch = match[0].match(/(href|src|srcset|poster)/i);
    const attr = (attrMatch?.[1] || "").toLowerCase();
    if (!value || !attr) {
      continue;
    }

    const valueCandidates =
      attr === "srcset"
        ? value
            .split(",")
            .map((entry) => entry.trim())
            .map((entry) => entry.split(/\s+/)[0])
            .filter(Boolean)
        : [value.trim()];

    for (const candidate of valueCandidates) {
      if (!shouldCheck(candidate)) {
        continue;
      }
      refs.push({ attr, value: candidate });
    }
  }

  return refs;
}

function shouldCheck(reference) {
  const value = reference.trim();
  if (!value || value.startsWith("#")) {
    return false;
  }
  if (value.startsWith("data:") || value.startsWith("javascript:") || value.startsWith("mailto:") || value.startsWith("tel:")) {
    return false;
  }
  if (/^[a-z][a-z0-9+.-]*:/i.test(value) || value.startsWith("//")) {
    return false;
  }
  return true;
}

function resolveLocalPath(reference, pageDir) {
  const trimmed = reference.split(/[?#]/, 1)[0].trim();
  if (!trimmed) {
    return null;
  }

  const normalized = toPosix(trimmed);
  if (normalized === ".." || normalized.startsWith("../") || normalized.includes("/../") || normalized.includes("/./")) {
    return null;
  }

  if (normalized.startsWith("/")) {
    return toPosix(path.posix.normalize(normalized.slice(1)));
  }

  if (normalized === "." || normalized === "./") {
    return toPosix(path.posix.normalize(pageDir));
  }

  return path.posix.normalize(path.posix.join(pageDir, normalized));
}

async function existsAnyCandidate(basePath, hasSlash, hasExt) {
  const candidates = [];
  const safeBase = path.join(distDir, basePath || "");

  if (!basePath) {
    candidates.push(path.join(distDir, "index.html"));
    return existsAny(candidates);
  }

  if (hasSlash || !hasExt) {
    candidates.push(`${safeBase}/index.html`);
    candidates.push(`${safeBase}.html`);
  } else {
    candidates.push(safeBase);
  }

  return existsAny(candidates);
}

function hasExtension(value) {
  const basename = path.posix.basename(value);
  return path.extname(basename) !== "";
}

async function existsAny(candidates) {
  for (const file of candidates) {
    try {
      await fs.access(file);
      return true;
    } catch {
      // continue
    }
  }
  return false;
}

async function collectFiles(dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    if (entry.name === "output" || entry.name === ".git" || entry.name === "node_modules") {
      continue;
    }

    const filePath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectFiles(filePath)));
      continue;
    }

    if (entry.isFile()) {
      files.push(filePath);
    }
  }

  return files;
}

function toPosix(value) {
  return value.split(path.sep).join(path.posix.sep);
}
