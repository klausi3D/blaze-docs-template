import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import matter from "gray-matter";

const __filename = fileURLToPath(import.meta.url);
const repoDir = path.dirname(__filename);
const contentDir = path.resolve(repoDir, "..", "content");

const issues = [];
const pages = [];

const markdownFiles = (await collectFiles(contentDir)).filter((file) => file.endsWith(".md"));

for (const filePath of markdownFiles) {
  const sourceRel = toPosix(path.relative(contentDir, filePath));
  const raw = await fs.readFile(filePath, "utf8");
  const parsed = matter(raw);

  const page = {
    sourceRel,
    filePath,
  };

  if (!isObject(parsed.data)) {
    issues.push({ file: sourceRel, field: "frontmatter", message: "Frontmatter must be an object." });
    continue;
  }

  const validated = validateFrontMatter(parsed.data, sourceRel);
  if (!validated.ok) {
    issues.push(...validated.errors);
    continue;
  }

  page.urlPath = validated.urlPath;
  page.order = validated.order;
  page.navExclude = validated.navExclude;
  page.searchExclude = validated.searchExclude;
  pages.push(page);

  await validateInternalMarkdownLinks(sourceRel, parsed.content);
}

validateOutputPathUniqueness();

if (issues.length > 0) {
  console.error("Typecheck failed:");
  for (const issue of issues) {
    const field = issue.field ? `.${issue.field}` : "";
    console.error(`- ${issue.file}${field}: ${issue.message}`);
  }
  process.exit(1);
}

console.log(`Typecheck passed (${pages.length} page files, ${markdownFiles.length} markdown files).`);

function validateFrontMatter(data, sourceRel) {
  const errors = [];

  const title = normalizeText(data.title);
  if (!title) {
    errors.push({ file: sourceRel, field: "title", message: "Title must be a non-empty string." });
  }

  const slug = resolveSlug(sourceRel, data.slug);
  if (!isSafeSlug(slug)) {
    errors.push({ file: sourceRel, field: "slug", message: "Slug resolves to an unsafe path." });
  }

  const order = normalizeNumber(data.order, 999);
  if (!Number.isFinite(order)) {
    errors.push({ file: sourceRel, field: "order", message: "Order must be a number." });
  }

  const navExclude = parseBoolean(data.nav_exclude, false);
  const searchExclude = parseBoolean(data.search_exclude, false);

  return {
    ok: errors.length === 0,
    errors,
    urlPath: slug ? `${slug}/` : "",
    order,
    navExclude,
    searchExclude,
  };
}

async function validateInternalMarkdownLinks(sourceRel, markdown) {
  const pattern = /\[[^\]]*?\]\(([^)\s]+)(?:\s+["'][^"']*["'])?\)/g;
  let match;
  const sourceDir = path.posix.dirname(sourceRel);

  while ((match = pattern.exec(markdown)) !== null) {
    const href = match[1];
    if (!href) {
      continue;
    }

    if (
      /^[a-z][a-z0-9+.-]*:/i.test(href) ||
      href.startsWith("//") ||
      href.startsWith("#") ||
      href.startsWith("mailto:") ||
      href.startsWith("tel:")
    ) {
      continue;
    }

    const [pathPart] = href.split("#", 2);
    if (!pathPart.endsWith(".md")) {
      continue;
    }

    const decodedPath = safeDecodeURIComponent(pathPart);
    const target = resolveMarkdownLinkTarget(sourceRel, sourceDir, decodedPath);

    if (!target) {
      issues.push({
        file: sourceRel,
        field: "markdown links",
        message: `Invalid relative markdown link target "${href}".`,
      });
      continue;
    }

    if (!target.endsWith(".md")) {
      issues.push({
        file: sourceRel,
        field: "markdown links",
        message: `Markdown link must point to a .md file: "${href}".`,
      });
      continue;
    }

    if (!target.startsWith(contentDir + path.sep) && target !== contentDir) {
      issues.push({
        file: sourceRel,
        field: "markdown links",
        message: `Link escapes content directory: "${href}".`,
      });
      continue;
    }

    if (!target.startsWith(contentDir)) {
      issues.push({
        file: sourceRel,
        field: "markdown links",
        message: `Link escapes content directory: "${href}".`,
      });
      continue;
    }

    if (!(await existsPathSafe(target))) {
      issues.push({
        file: sourceRel,
        field: "markdown links",
        message: `Missing markdown link target "${href}".`,
      });
    }
  }
}

function validateOutputPathUniqueness() {
  const seen = new Map();
  for (const page of pages) {
    const key = page.urlPath;
    const prev = seen.get(key);
    if (prev) {
      issues.push({
        file: page.sourceRel,
        field: "frontmatter.slug",
        message: `Duplicate output path "${key}" also used in ${prev}.`,
      });
      continue;
    }
    seen.set(key, page.sourceRel);
  }
}

function resolveSlug(sourceRel, frontmatterSlug) {
  if (typeof frontmatterSlug === "string" && frontmatterSlug.trim()) {
    return normalizeSlug(frontmatterSlug);
  }

  if (sourceRel === "index.md") {
    return "";
  }

  const withoutExt = sourceRel.replace(/\.md$/i, "");
  if (withoutExt.endsWith("/index")) {
    return normalizeSlug(withoutExt.slice(0, -"/index".length));
  }
  return normalizeSlug(withoutExt);
}

function normalizeSlug(input) {
  const normalized = toPosix(String(input))
    .replace(/^\/+|\/+$/g, "")
    .replace(/\s+/g, "-")
    .toLowerCase();

  const parts = normalized
    .split("/")
    .map((part) => {
      if (part === "." || part === "..") {
        return "";
      }
      return part.replace(/[^a-z0-9-]/g, "").trim();
    })
    .filter(Boolean);

  return parts.join("/");
}

function isSafeSlug(slug) {
  if (!slug) {
    return true;
  }
  if (slug.includes("../") || slug.includes("./") || slug.includes("//")) {
    return false;
  }
  return true;
}

function normalizeText(value) {
  return typeof value === "string" ? collapseWhitespace(value) : "";
}

function normalizeNumber(value, fallback) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) {
    return Number(value);
  }
  return fallback;
}

function parseBoolean(value, fallback = false) {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    return value !== 0;
  }
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "true" || normalized === "1" || normalized === "yes") {
      return true;
    }
    if (normalized === "false" || normalized === "0" || normalized === "no") {
      return false;
    }
  }
  return fallback;
}

function safeDecodeURIComponent(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function resolveMarkdownLinkTarget(sourceRel, sourceDir, rawPath) {
  const normalizedPath = toPosix(rawPath).replace(/\\/g, "/").trim();
  if (!normalizedPath || normalizedPath === ".") {
    return path.resolve(contentDir, sourceRel);
  }

  const candidate = normalizedPath.startsWith("/")
    ? normalizedPath.slice(1)
    : path.posix.normalize(path.posix.join(sourceDir, normalizedPath));

  if (candidate.startsWith("../") || candidate.startsWith("..") || candidate.includes("/../") || candidate.includes("\\")) {
    return null;
  }

  return path.resolve(contentDir, candidate);
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function existsPathSafe(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function collectFiles(dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const results = [];

  for (const entry of entries) {
    if (entry.name.startsWith(".")) {
      continue;
    }

    const filePath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...(await collectFiles(filePath)));
      continue;
    }
    results.push(filePath);
  }

  return results;
}

function toPosix(value) {
  return value.split(path.sep).join(path.posix.sep);
}

function collapseWhitespace(value) {
  return String(value).replace(/\s+/g, " ").trim();
}
