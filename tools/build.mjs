import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import matter from "gray-matter";
import { marked } from "marked";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, "..");
const contentDir = path.join(rootDir, "content");
const assetSourceDir = path.join(rootDir, "src", "assets");
const distDir = path.join(rootDir, "dist");
const distAssetDir = path.join(distDir, "assets");

await build();

async function build() {
  await fs.rm(distDir, { recursive: true, force: true });
  await fs.mkdir(distAssetDir, { recursive: true });

  const pages = await loadPages();

  if (pages.length === 0) {
    throw new Error("No markdown files found in content/");
  }

  const pagesBySource = new Map(pages.map((page) => [page.sourceRel, page]));
  for (const page of pages) {
    const rendered = renderMarkdown(page.bodyMarkdown, page, pagesBySource);
    page.bodyHtml = rendered.html;
    page.headings = rendered.headings;
  }

  const criticalCss = minifyCss(await readUtf8(path.join(assetSourceDir, "critical.css")));
  const appCss = minifyCss(await readUtf8(path.join(assetSourceDir, "app.css")));
  const appJs = await readUtf8(path.join(assetSourceDir, "app.js"));
  const searchWorkerJs = await readUtf8(path.join(assetSourceDir, "search-worker.js"));
  await fs.copyFile(path.join(assetSourceDir, "favicon.svg"), path.join(distAssetDir, "favicon.svg"));

  const appCssFile = await writeHashedAsset("app", "css", appCss);
  const appJsFile = await writeHashedAsset("app", "js", appJs);
  const searchWorkerFile = await writeHashedAsset("search-worker", "js", searchWorkerJs);

  const searchIndexDocs = pages.map((page) => ({
    title: page.title,
    url: page.urlPath || "./",
    headings: page.headings.map((heading) => heading.text).join(" "),
    excerpt: excerptText(page.searchText, 140),
    text: page.searchText,
  }));

  const searchIndexFile = await writeHashedAsset(
    "search-index",
    "json",
    JSON.stringify(searchIndexDocs),
  );

  const swTemplate = await readUtf8(path.join(assetSourceDir, "sw.js"));
  const precachePaths = [
    "./",
    "404.html",
    ...pages.filter((page) => page.urlPath).map((page) => page.urlPath),
    `assets/${appCssFile}`,
    `assets/${appJsFile}`,
    `assets/${searchWorkerFile}`,
    `assets/${searchIndexFile}`,
    "assets/favicon.svg",
  ];

  const buildHash = hashOf(JSON.stringify(precachePaths)).slice(0, 12);
  const swSource = swTemplate
    .replace("__BUILD_HASH__", buildHash)
    .replace("__PRECACHE_MANIFEST__", JSON.stringify(precachePaths));

  const swFile = `sw.${hashOf(swSource).slice(0, 10)}.js`;
  await fs.writeFile(path.join(distDir, swFile), swSource, "utf8");

  const orderedPages = [...pages].sort((a, b) => a.order - b.order || a.title.localeCompare(b.title));

  for (const page of pages) {
    const html = renderPageHtml({
      page,
      orderedPages,
      criticalCss,
      appCssFile,
      appJsFile,
      searchWorkerFile,
      searchIndexFile,
      swFile,
      generatedAt: new Date().toISOString(),
    });

    const outputAbsPath = path.join(distDir, page.outputPath);
    await fs.mkdir(path.dirname(outputAbsPath), { recursive: true });
    await fs.writeFile(outputAbsPath, html, "utf8");
  }

  const notFoundHtml = renderPageHtml({
    page: {
      title: "Not Found",
      description: "Page not found",
      outputPath: "404.html",
      urlPath: "404.html",
      bodyHtml: "<h1>Page not found</h1><p>The page you requested does not exist.</p><p><a href=\"./\">Return to home</a></p>",
      headings: [],
      searchText: "",
      slug: "404",
    },
    orderedPages,
    criticalCss,
    appCssFile,
    appJsFile,
    searchWorkerFile,
    searchIndexFile,
    swFile,
    generatedAt: new Date().toISOString(),
    noindex: true,
  });

  await fs.writeFile(path.join(distDir, "404.html"), notFoundHtml, "utf8");
  await fs.writeFile(path.join(distDir, ".nojekyll"), "\n", "utf8");

  const summary = {
    pages: pages.length,
    assets: [appCssFile, appJsFile, searchWorkerFile, searchIndexFile, swFile],
  };
  console.log(JSON.stringify(summary, null, 2));
}

async function loadPages() {
  const markdownFiles = await listFilesRecursive(contentDir);
  const pages = [];
  const seenOutputPaths = new Set();

  for (const absPath of markdownFiles.filter((file) => file.endsWith(".md"))) {
    const sourceRel = toPosix(path.relative(contentDir, absPath));
    const raw = await readUtf8(absPath);
    const parsed = matter(raw);
    const slug = resolveSlug(sourceRel, parsed.data.slug);
    const outputPath = slug ? `${slug}/index.html` : "index.html";

    if (seenOutputPaths.has(outputPath)) {
      throw new Error(`Duplicate output path: ${outputPath}`);
    }
    seenOutputPaths.add(outputPath);

    const title = cleanText(parsed.data.title) || titleFromSlug(slug || "index");
    const description = cleanText(parsed.data.description);
    const orderNumber = Number(parsed.data.order);
    const order = Number.isFinite(orderNumber) ? orderNumber : 999;

    pages.push({
      sourceRel,
      slug,
      outputPath,
      urlPath: slug ? `${slug}/` : "",
      title,
      description,
      order,
      bodyMarkdown: parsed.content.trim(),
      bodyHtml: "",
      headings: [],
      searchText: "",
    });
  }

  return pages;
}

function renderMarkdown(markdown, page, pagesBySource) {
  const rawHtml = marked.parse(markdown);
  const html = typeof rawHtml === "string" ? rawHtml : String(rawHtml);

  const withRewrittenLinks = rewriteLinks(html, page, pagesBySource);
  const withHeadingAnchors = injectHeadingAnchors(withRewrittenLinks);
  const optimized = optimizeImages(withHeadingAnchors.html);
  const searchText = collapseWhitespace(stripTags(optimized));

  page.searchText = searchText;

  return {
    html: optimized,
    headings: withHeadingAnchors.headings,
  };
}

function rewriteLinks(html, page, pagesBySource) {
  return html.replace(/href="([^"]+)"/g, (_, href) => {
    const rewritten = rewriteHref(href, page, pagesBySource);
    return `href="${escapeAttribute(rewritten)}"`;
  });
}

function rewriteHref(href, page, pagesBySource) {
  if (!href || href.startsWith("#")) {
    return href;
  }

  if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith("//") || href.startsWith("/")) {
    return href;
  }

  const [pathPart, hashPart] = href.split("#", 2);
  if (!pathPart.endsWith(".md")) {
    return href;
  }

  const sourceDir = path.posix.dirname(page.sourceRel);
  const resolvedSourcePath = path.posix.normalize(path.posix.join(sourceDir, pathPart));
  const targetPage = pagesBySource.get(resolvedSourcePath);

  if (!targetPage) {
    return href;
  }

  const relativePath = relativeHref(page.outputPath, targetPage.urlPath || "");
  return hashPart ? `${relativePath}#${hashPart}` : relativePath;
}

function injectHeadingAnchors(html) {
  const seen = new Map();
  const headings = [];
  const output = html.replace(/<h([1-6])(?:\s[^>]*)?>([\s\S]*?)<\/h\1>/g, (full, depthText, innerHtml) => {
    const depth = Number(depthText);
    const label = collapseWhitespace(stripTags(innerHtml));
    const id = createUniqueSlug(label, seen);

    if (depth >= 2 && depth <= 3) {
      headings.push({ depth, text: label, id });
    }

    const safeLabel = escapeAttribute(`Jump to section: ${label}`);
    return `<h${depth} id="${id}"><a class="anchor-link" href="#${id}" aria-label="${safeLabel}">${innerHtml}</a></h${depth}>`;
  });

  return { html: output, headings };
}

function optimizeImages(html) {
  return html.replace(/<img\b([^>]*)>/g, (full, attrs) => {
    let nextAttrs = attrs;
    if (!/\sloading=/.test(nextAttrs)) {
      nextAttrs += ' loading="lazy"';
    }
    if (!/\sdecoding=/.test(nextAttrs)) {
      nextAttrs += ' decoding="async"';
    }
    return `<img${nextAttrs}>`;
  });
}

function renderPageHtml({
  page,
  orderedPages,
  criticalCss,
  appCssFile,
  appJsFile,
  searchWorkerFile,
  searchIndexFile,
  swFile,
  generatedAt,
  noindex = false,
}) {
  const siteRoot = siteRootFromOutputPath(page.outputPath);
  const cssHref = relativeHref(page.outputPath, `assets/${appCssFile}`);
  const jsHref = relativeHref(page.outputPath, `assets/${appJsFile}`);

  const navLinks = orderedPages
    .map((item) => {
      const href = relativeHref(page.outputPath, item.urlPath || "");
      const activeClass = item.slug === page.slug ? " is-active" : "";
      return `<li><a data-prefetch class="nav-link${activeClass}" href="${escapeAttribute(href)}">${escapeHtml(item.title)}</a></li>`;
    })
    .join("");

  const tocLinks = page.headings.length
    ? page.headings
        .map((heading) => {
          const depthClass = heading.depth === 3 ? " toc-depth-3" : "";
          return `<li><a class="toc-link${depthClass}" href="#${heading.id}">${escapeHtml(heading.text)}</a></li>`;
        })
        .join("")
    : '<li><span class="toc-link">No sections</span></li>';

  const title = page.urlPath ? `${page.title} | Blaze Docs` : page.title;
  const description = page.description || "Fast, static documentation template.";
  const robots = noindex ? '<meta name="robots" content="noindex">' : "";

  return `<!doctype html>
<html lang="en" data-site-root="${escapeAttribute(siteRoot)}" data-search-worker="assets/${searchWorkerFile}" data-search-index="assets/${searchIndexFile}" data-sw="${swFile}">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${escapeHtml(title)}</title>
  <meta name="description" content="${escapeAttribute(description)}">
  ${robots}
  <style>${criticalCss}</style>
  <link rel="preload" href="${escapeAttribute(cssHref)}" as="style">
  <link rel="stylesheet" href="${escapeAttribute(cssHref)}">
  <link rel="icon" href="${escapeAttribute(relativeHref(page.outputPath, "assets/favicon.svg"))}" type="image/svg+xml">
  <script type="speculationrules">{"prefetch":[{"source":"document","where":{"selector_matches":"a[data-prefetch]"},"eagerness":"moderate"}]}</script>
  <script type="module" src="${escapeAttribute(jsHref)}"></script>
</head>
<body>
  <a class="skip-link" href="#main-content">Skip to main content</a>
  <header class="topbar">
    <div class="topbar-inner">
      <button class="menu-toggle" data-menu-toggle type="button" aria-label="Toggle navigation">Menu</button>
      <a class="brand" href="${escapeAttribute(relativeHref(page.outputPath, ""))}">Blaze Docs</a>
      <div class="search-wrap">
        <label class="sr-only" for="site-search">Search documentation</label>
        <input class="search-input" id="site-search" data-search-input type="search" placeholder="Search docs" autocomplete="off" spellcheck="false">
        <ul class="search-results" data-search-results aria-live="polite"></ul>
      </div>
    </div>
  </header>
  <div class="site-shell" data-site-shell>
    <aside class="sidebar" aria-label="Primary navigation">
      <h2>Pages</h2>
      <ul class="nav-list">${navLinks}</ul>
    </aside>
    <div class="content-column">
      <main id="main-content" class="doc-panel">
        ${page.bodyHtml}
        <p class="doc-footer">Generated at ${escapeHtml(generatedAt)}</p>
      </main>
      <aside class="toc" aria-label="On this page">
        <h2>On this page</h2>
        <ul class="toc-list">${tocLinks}</ul>
      </aside>
    </div>
  </div>
</body>
</html>`;
}

async function writeHashedAsset(baseName, extension, rawContent) {
  const hash = hashOf(rawContent).slice(0, 10);
  const fileName = `${baseName}.${hash}.${extension}`;
  const outputPath = path.join(distAssetDir, fileName);
  await fs.writeFile(outputPath, rawContent, "utf8");
  return fileName;
}

function resolveSlug(sourceRel, frontmatterSlug) {
  if (typeof frontmatterSlug === "string" && frontmatterSlug.trim().length > 0) {
    const normalized = normalizeSlug(frontmatterSlug);
    if (normalized === "index") {
      return "";
    }
    return normalized;
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
  const normalized = toPosix(input)
    .replace(/^\/+|\/+$/g, "")
    .replace(/\s+/g, "-")
    .toLowerCase();

  if (!normalized) {
    return "";
  }

  const clean = normalized
    .split("/")
    .map((part) => part.replace(/[^a-z0-9-]/g, ""))
    .filter(Boolean)
    .join("/");

  return clean;
}

function relativeHref(fromOutputPath, toSitePath) {
  const fromDir = path.posix.dirname(toPosix(fromOutputPath));
  const toPath = toSitePath ? toPosix(toSitePath) : ".";
  let relative = path.posix.relative(fromDir, toPath);

  if (!relative) {
    relative = ".";
  }

  if (toSitePath && toSitePath.endsWith("/") && !relative.endsWith("/")) {
    relative += "/";
  }

  return relative;
}

function siteRootFromOutputPath(outputPath) {
  const fromDir = path.posix.dirname(toPosix(outputPath));
  const rel = path.posix.relative(fromDir, ".");
  if (!rel) {
    return "./";
  }
  return rel.endsWith("/") ? rel : `${rel}/`;
}

function createUniqueSlug(text, seen) {
  const base = slugify(text) || "section";
  const count = seen.get(base) || 0;
  seen.set(base, count + 1);
  return count === 0 ? base : `${base}-${count + 1}`;
}

function slugify(value) {
  return cleanText(value)
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-");
}

function excerptText(text, maxLength) {
  if (text.length <= maxLength) {
    return text;
  }
  return `${text.slice(0, maxLength).trimEnd()}...`;
}

function minifyCss(css) {
  return css
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\s+/g, " ")
    .replace(/\s*([{}:;,])\s*/g, "$1")
    .trim();
}

function stripTags(html) {
  return html.replace(/<[^>]+>/g, " ");
}

function collapseWhitespace(value) {
  return value.replace(/\s+/g, " ").trim();
}

function titleFromSlug(slug) {
  return slug
    .split("/")
    .pop()
    .split("-")
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

function cleanText(value) {
  return typeof value === "string" ? collapseWhitespace(value) : "";
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function escapeAttribute(value) {
  return escapeHtml(value).replaceAll("`", "&#96;");
}

function hashOf(content) {
  return createHash("sha256").update(String(content)).digest("hex");
}

function toPosix(value) {
  return value.split(path.sep).join(path.posix.sep);
}

async function listFilesRecursive(dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const absPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listFilesRecursive(absPath)));
      continue;
    }
    files.push(absPath);
  }

  return files;
}

async function readUtf8(filePath) {
  return fs.readFile(filePath, "utf8");
}
