import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";
import matter from "gray-matter";
import { marked } from "marked";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, "..");
const contentDir = path.join(rootDir, "content");
const assetSourceDir = path.join(rootDir, "src", "assets");
const distDir = path.join(rootDir, "dist");
const distAssetDir = path.join(distDir, "assets");
const distMediaDir = path.join(distAssetDir, "media");
const fontSourceDir = path.join(assetSourceDir, "fonts");

const responsiveImageWidths = [480, 768, 1024, 1440];
const optimizableRasterExtensions = new Set([".avif", ".gif", ".jpeg", ".jpg", ".png", ".webp"]);

await build();

async function build() {
  await fs.rm(distDir, { recursive: true, force: true });
  await fs.mkdir(distAssetDir, { recursive: true });
  await fs.mkdir(distMediaDir, { recursive: true });

  const pages = await loadPages();

  if (pages.length === 0) {
    throw new Error("No markdown files found in content/");
  }

  const mediaPipeline = createMediaPipeline();
  const pagesBySource = new Map(pages.map((page) => [page.sourceRel, page]));

  for (const page of pages) {
    const rendered = await renderMarkdown(page.bodyMarkdown, page, pagesBySource, mediaPipeline);
    page.bodyHtml = rendered.html;
    page.headings = rendered.headings;
  }

  const criticalCss = minifyCss(await readUtf8(path.join(assetSourceDir, "critical.css")));
  const appCss = minifyCss(await readUtf8(path.join(assetSourceDir, "app.css")));
  const appJs = await readUtf8(path.join(assetSourceDir, "app.js"));
  const searchWorkerJs = await readUtf8(path.join(assetSourceDir, "search-worker.js"));
  await fs.copyFile(path.join(assetSourceDir, "favicon.svg"), path.join(distAssetDir, "favicon.svg"));
  const copiedFontAssets = await copyDirectory(fontSourceDir, path.join(distAssetDir, "fonts"));

  const appCssFile = await writeHashedAsset("app", "css", appCss);
  const appJsFile = await writeHashedAsset("app", "js", appJs);
  const searchWorkerFile = await writeHashedAsset("search-worker", "js", searchWorkerJs);

  const searchIndexDocs = pages
    .filter((page) => !page.searchExclude)
    .map((page) => ({
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
    ...copiedFontAssets.map((fontPath) => `assets/${fontPath}`),
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
      bodyHtml:
        '<h1>Page not found</h1><p>The page you requested does not exist.</p><p><a href="./">Return to home</a></p>',
      headings: [],
      searchText: "",
      slug: "404",
      navExclude: true,
      searchExclude: true,
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
    mediaAssets: mediaPipeline.getGeneratedPaths().length,
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
    const navExclude = parseBoolean(parsed.data.nav_exclude, false);
    const searchExclude = parseBoolean(parsed.data.search_exclude, false);

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
      navExclude,
      searchExclude,
    });
  }

  return pages;
}

async function renderMarkdown(markdown, page, pagesBySource, mediaPipeline) {
  const prepared = extractFootnotes(markdown);
  const rawHtml = marked.parse(prepared.markdown);
  const html = typeof rawHtml === "string" ? rawHtml : String(rawHtml);

  const withFootnotes = materializeFootnotes(html, prepared.footnotes);
  const withRewrittenLinks = rewriteLinks(withFootnotes, page, pagesBySource);
  const withHeadingAnchors = injectHeadingAnchors(withRewrittenLinks);
  const optimizedImages = await optimizeImages(withHeadingAnchors.html, page, mediaPipeline);
  const optimized = await optimizeVideos(optimizedImages, page, mediaPipeline);
  const normalized = unwrapStandaloneFigures(optimized);
  const searchText = collapseWhitespace(stripTags(normalized));

  page.searchText = searchText;

  return {
    html: normalized,
    headings: withHeadingAnchors.headings,
  };
}

function extractFootnotes(markdown) {
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  const bodyLines = [];
  const definitions = new Map();
  let activeFence = null;

  for (let index = 0; index < lines.length; index += 1) {
    const currentLine = lines[index];
    const fenceMatch = currentLine.match(/^([`~]{3,})/);
    if (fenceMatch) {
      const marker = fenceMatch[1].charAt(0);
      if (activeFence === null) {
        activeFence = marker;
      } else if (activeFence === marker) {
        activeFence = null;
      }
      bodyLines.push(currentLine);
      continue;
    }

    if (activeFence !== null) {
      bodyLines.push(currentLine);
      continue;
    }

    const definitionMatch = currentLine.match(/^\[\^([A-Za-z0-9_-]+)\]:\s*(.*)$/);

    if (!definitionMatch) {
      bodyLines.push(currentLine);
      continue;
    }

    const footnoteKey = definitionMatch[1];
    const definitionLines = [definitionMatch[2]];
    let cursor = index + 1;
    while (cursor < lines.length) {
      const nextLine = lines[cursor];
      if (/^(?: {2,}|\t)/.test(nextLine)) {
        definitionLines.push(nextLine.replace(/^(?: {2,}|\t)/, ""));
        cursor += 1;
        continue;
      }

      if (nextLine.trim() === "" && /^(?: {2,}|\t)/.test(lines[cursor + 1] || "")) {
        definitionLines.push("");
        cursor += 1;
        continue;
      }

      break;
    }

    index = cursor - 1;

    const definition = definitionLines.join("\n").trim();
    if (definition.length > 0) {
      definitions.set(footnoteKey, definition);
    }
  }

  const orderedFootnotes = [];
  const referencesByKey = new Map();
  const normalizedKeyCounts = new Map();
  const markdownWithTokens = bodyLines.join("\n").replace(/\[\^([A-Za-z0-9_-]+)\]/g, (full, rawKey) => {
    const definition = definitions.get(rawKey);
    if (!definition) {
      return full;
    }

    let note = referencesByKey.get(rawKey);
    if (!note) {
      const baseId = formatFootnoteId(rawKey);
      const normalizedKeyCount = normalizedKeyCounts.get(baseId) || 0;
      const noteId = normalizedKeyCount === 0 ? baseId : `${baseId}-${normalizedKeyCount + 1}`;
      normalizedKeyCounts.set(baseId, normalizedKeyCount + 1);

      note = {
        key: rawKey,
        noteId,
        number: orderedFootnotes.length + 1,
        content: definition,
        refs: [],
      };
      referencesByKey.set(rawKey, note);
      orderedFootnotes.push(note);
    }

    const referenceIndex = note.refs.length + 1;
    note.refs.push(referenceIndex);
    return `@@FNREF:${note.noteId}:${note.number}:${referenceIndex}@@`;
  });

  return {
    markdown: markdownWithTokens,
    footnotes: orderedFootnotes,
  };
}

function materializeFootnotes(html, footnotes) {
  const withReferenceLinks = html.replace(
    /@@FNREF:([A-Za-z0-9_-]+):(\d+):(\d+)@@/g,
    (_, noteId, numberText, referenceIndexText) => {
      const number = Number(numberText);
      const referenceIndex = Number(referenceIndexText);
      const referenceId = referenceIndex === 1 ? `fnref-${noteId}` : `fnref-${noteId}-${referenceIndex}`;
      return `<sup class="footnote-ref" id="${referenceId}"><a href="#fn-${noteId}" aria-label="Footnote ${number}">${number}</a></sup>`;
    },
  );

  if (footnotes.length === 0) {
    return withReferenceLinks;
  }

  const footnoteItems = footnotes
    .map((note) => {
      const renderedContent = marked.parse(note.content);
      const contentHtml = typeof renderedContent === "string" ? renderedContent : String(renderedContent);
      const backlinks = note.refs
        .map((referenceIndex) => {
          const referenceId =
            referenceIndex === 1 ? `fnref-${note.noteId}` : `fnref-${note.noteId}-${referenceIndex}`;
          return `<a class="footnote-backref" href="#${referenceId}" aria-label="Back to reference ${referenceIndex}">&#8617;</a>`;
        })
        .join(" ");

      return `<li id="fn-${note.noteId}" class="footnote-item">${contentHtml}<p class="footnote-backrefs">${backlinks}</p></li>`;
    })
    .join("");

  return `${withReferenceLinks}\n<section class="footnotes" aria-label="Footnotes">\n<h2>Footnotes</h2>\n<ol>${footnoteItems}</ol>\n</section>`;
}

function formatFootnoteId(value) {
  const normalized = String(value)
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[-_]+|[-_]+$/g, "");

  return normalized || "note";
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

async function optimizeImages(html, page, mediaPipeline) {
  const imageTagPattern = /<img\b([^>]*)>/gi;
  let output = "";
  let previousIndex = 0;
  let match;

  while ((match = imageTagPattern.exec(html)) !== null) {
    output += html.slice(previousIndex, match.index);
    const attrs = parseHtmlAttributes(match[1] || "");
    output += await rewriteImageTag(attrs, page, mediaPipeline);
    previousIndex = imageTagPattern.lastIndex;
  }

  output += html.slice(previousIndex);
  return output;
}

async function optimizeVideos(html, page, mediaPipeline) {
  const videoTagPattern = /<video\b([^>]*)>([\s\S]*?)<\/video>/gi;
  let output = "";
  let previousIndex = 0;
  let match;

  while ((match = videoTagPattern.exec(html)) !== null) {
    output += html.slice(previousIndex, match.index);
    const attrs = parseHtmlAttributes(match[1] || "");
    const innerHtml = match[2] || "";
    output += await rewriteVideoTag(attrs, innerHtml, page, mediaPipeline);
    previousIndex = videoTagPattern.lastIndex;
  }

  output += html.slice(previousIndex);
  return output;
}

async function rewriteImageTag(attrs, page, mediaPipeline) {
  const imageAttrs = cloneAttributeMap(attrs);
  ensureImagePerformanceAttrs(imageAttrs);

  const srcValue = getAttribute(imageAttrs, "src");
  if (!srcValue) {
    return `<img${serializeHtmlAttributes(imageAttrs)}>`;
  }

  const localSource = resolveLocalMediaSource(srcValue, page);
  if (!localSource || !isOptimizableRasterExtension(localSource.extension)) {
    return `<img${serializeHtmlAttributes(imageAttrs)}>`;
  }

  try {
    const captionText = resolveImageCaption(imageAttrs);
    removeAttributes(imageAttrs, ["title"]);
    const processed =
      localSource.extension === ".gif"
        ? await mediaPipeline.processGif(localSource.absolutePath, localSource.sourceRelFromRoot)
        : await mediaPipeline.processImage(localSource.absolutePath, localSource.sourceRelFromRoot);

    if (processed.kind === "video") {
      const videoMarkup = buildVideoMarkup(imageAttrs, processed, page.outputPath);
      return wrapMediaFigure(videoMarkup, captionText);
    }

    const pictureMarkup = buildPictureMarkup(imageAttrs, processed, page.outputPath);
    return wrapMediaFigure(pictureMarkup, captionText);
  } catch (error) {
    console.warn(
      `[build] Unable to optimize image "${srcValue}" in "${page.sourceRel}": ${error.message}`,
    );
    return `<img${serializeHtmlAttributes(imageAttrs)}>`;
  }
}

function buildPictureMarkup(originalImageAttrs, processedImage, outputPath) {
  const imgAttrs = cloneAttributeMap(originalImageAttrs);
  const sizes = getAttribute(imgAttrs, "sizes") || "100vw";
  const fallbackVariants = processedImage.fallback.variants;
  const fallbackLargest = fallbackVariants[fallbackVariants.length - 1];

  removeAttributes(imgAttrs, ["src", "srcset", "sizes", "width", "height", "title"]);
  setAttribute(imgAttrs, "src", mediaHref(outputPath, fallbackLargest.fileName));
  setAttribute(imgAttrs, "srcset", buildSrcSet(fallbackVariants, outputPath));
  setAttribute(imgAttrs, "sizes", sizes);
  setAttribute(imgAttrs, "width", processedImage.width);
  setAttribute(imgAttrs, "height", processedImage.height);
  ensureImagePerformanceAttrs(imgAttrs);

  const avifSrcSet = buildSrcSet(processedImage.avif, outputPath);
  const webpSrcSet = buildSrcSet(processedImage.webp, outputPath);
  const fallbackSrcSet = buildSrcSet(fallbackVariants, outputPath);

  const sourceMarkup = [
    `<source type="image/avif" srcset="${escapeAttribute(avifSrcSet)}" sizes="${escapeAttribute(sizes)}">`,
    `<source type="image/webp" srcset="${escapeAttribute(webpSrcSet)}" sizes="${escapeAttribute(sizes)}">`,
    `<source type="${escapeAttribute(processedImage.fallback.mimeType)}" srcset="${escapeAttribute(fallbackSrcSet)}" sizes="${escapeAttribute(sizes)}">`,
  ].join("");

  return `<picture>${sourceMarkup}<img${serializeHtmlAttributes(imgAttrs)}></picture>`;
}

function buildVideoMarkup(originalImageAttrs, processedVideo, outputPath) {
  const videoAttrs = cloneAttributeMap(originalImageAttrs);
  const fallbackImgAttrs = cloneAttributeMap(originalImageAttrs);
  const posterHref = mediaHref(outputPath, processedVideo.posterFileName);

  removeAttributes(videoAttrs, [
    "src",
    "srcset",
    "sizes",
    "width",
    "height",
    "loading",
    "decoding",
    "alt",
  ]);

  setAttribute(videoAttrs, "autoplay", null);
  setAttribute(videoAttrs, "muted", null);
  setAttribute(videoAttrs, "loop", null);
  setAttribute(videoAttrs, "playsinline", null);
  setAttribute(videoAttrs, "preload", "none");
  setAttribute(videoAttrs, "poster", posterHref);
  setAttribute(videoAttrs, "width", processedVideo.width);
  setAttribute(videoAttrs, "height", processedVideo.height);

  const fallbackAlt = getAttribute(originalImageAttrs, "alt") || "";
  removeAttributes(fallbackImgAttrs, ["src", "srcset", "sizes", "width", "height", "title"]);
  setAttribute(fallbackImgAttrs, "src", posterHref);
  setAttribute(fallbackImgAttrs, "alt", fallbackAlt);
  setAttribute(fallbackImgAttrs, "width", processedVideo.width);
  setAttribute(fallbackImgAttrs, "height", processedVideo.height);
  ensureImagePerformanceAttrs(fallbackImgAttrs);

  const webmHref = mediaHref(outputPath, processedVideo.webmFileName);
  const mp4Href = mediaHref(outputPath, processedVideo.mp4FileName);

  return `<video${serializeHtmlAttributes(videoAttrs)}><source src="${escapeAttribute(webmHref)}" type="video/webm"><source src="${escapeAttribute(mp4Href)}" type="video/mp4"><img${serializeHtmlAttributes(fallbackImgAttrs)}></video>`;
}

function resolveImageCaption(attributes) {
  const titleText = collapseWhitespace(getAttribute(attributes, "title") || "");
  if (titleText) {
    return titleText;
  }

  const altText = collapseWhitespace(getAttribute(attributes, "alt") || "");
  if (altText) {
    return altText;
  }

  return "";
}

function wrapMediaFigure(mediaMarkup, captionText) {
  if (!captionText) {
    return mediaMarkup;
  }

  return `<figure class="media-figure">${mediaMarkup}<figcaption>${escapeHtml(captionText)}</figcaption></figure>`;
}

function unwrapStandaloneFigures(html) {
  return html.replace(/<p>\s*(<figure\b[\s\S]*?<\/figure>)\s*<\/p>/gi, "$1");
}

async function rewriteVideoTag(videoAttrs, innerHtml, page, mediaPipeline) {
  const nextVideoAttrs = cloneAttributeMap(videoAttrs);
  const originalPoster = getAttribute(nextVideoAttrs, "poster");
  const originalSrc = getAttribute(nextVideoAttrs, "src");
  const sourceTagPattern = /<source\b([^>]*)>/gi;
  const sourceMatches = [];
  let sourceMatch;

  while ((sourceMatch = sourceTagPattern.exec(innerHtml)) !== null) {
    sourceMatches.push({
      fullMatch: sourceMatch[0],
      attrs: parseHtmlAttributes(sourceMatch[1] || ""),
    });
  }

  let localSource = null;
  if (originalSrc) {
    localSource = resolveLocalMediaSource(originalSrc, page, { allowedExtensions: new Set([".mp4", ".webm"]) });
  }

  if (!localSource) {
    for (const source of sourceMatches) {
      const srcValue = getAttribute(source.attrs, "src");
      localSource = resolveLocalMediaSource(srcValue || "", page, {
        allowedExtensions: new Set([".mp4", ".webm"]),
      });
      if (localSource) {
        break;
      }
    }
  }

  if (!localSource) {
    return `<video${serializeHtmlAttributes(nextVideoAttrs)}>${innerHtml}</video>`;
  }

  try {
    const processed = await mediaPipeline.processVideo(localSource.absolutePath, localSource.sourceRelFromRoot);
    removeAttributes(nextVideoAttrs, ["src"]);
    if (!nextVideoAttrs.has("preload")) {
      setAttribute(nextVideoAttrs, "preload", "none");
    }
    if (!nextVideoAttrs.has("playsinline")) {
      setAttribute(nextVideoAttrs, "playsinline", null);
    }
    if (!originalPoster && processed.posterFileName) {
      setAttribute(nextVideoAttrs, "poster", mediaHref(page.outputPath, processed.posterFileName));
    }

    const normalizedSources = [];
    if (processed.webmFileName) {
      normalizedSources.push(
        `<source src="${escapeAttribute(mediaHref(page.outputPath, processed.webmFileName))}" type="video/webm">`,
      );
    }
    if (processed.mp4FileName) {
      normalizedSources.push(
        `<source src="${escapeAttribute(mediaHref(page.outputPath, processed.mp4FileName))}" type="video/mp4">`,
      );
    }

    const innerWithoutSources = innerHtml.replace(sourceTagPattern, "");
    return `<video${serializeHtmlAttributes(nextVideoAttrs)}>${normalizedSources.join("")}${innerWithoutSources}</video>`;
  } catch (error) {
    console.warn(
      `[build] Unable to optimize video "${localSource.sourceRelFromRoot}" in "${page.sourceRel}": ${error.message}`,
    );
    return `<video${serializeHtmlAttributes(nextVideoAttrs)}>${innerHtml}</video>`;
  }
}

function parseHtmlAttributes(rawAttributes) {
  const attributes = new Map();
  const attributePattern = /([^\s=\/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  let match;

  while ((match = attributePattern.exec(rawAttributes)) !== null) {
    const name = match[1];
    const key = name.toLowerCase();
    const value = match[2] ?? match[3] ?? match[4] ?? null;
    attributes.set(key, { name, value });
  }

  return attributes;
}

function serializeHtmlAttributes(attributes) {
  if (attributes.size === 0) {
    return "";
  }

  const output = [];
  for (const attribute of attributes.values()) {
    if (attribute.value === null) {
      output.push(attribute.name);
    } else {
      output.push(`${attribute.name}="${escapeAttribute(attribute.value)}"`);
    }
  }

  return ` ${output.join(" ")}`;
}

function cloneAttributeMap(attributes) {
  const clone = new Map();
  for (const [key, attribute] of attributes.entries()) {
    clone.set(key, { ...attribute });
  }
  return clone;
}

function getAttribute(attributes, name) {
  const attribute = attributes.get(name.toLowerCase());
  return attribute ? attribute.value : null;
}

function setAttribute(attributes, name, value) {
  const key = name.toLowerCase();
  const current = attributes.get(key);
  attributes.set(key, {
    name: current?.name || name,
    value: value === null ? null : String(value),
  });
}

function removeAttributes(attributes, names) {
  for (const name of names) {
    attributes.delete(name.toLowerCase());
  }
}

function ensureImagePerformanceAttrs(attributes) {
  if (!attributes.has("loading")) {
    setAttribute(attributes, "loading", "lazy");
  }
  if (!attributes.has("decoding")) {
    setAttribute(attributes, "decoding", "async");
  }
}

function resolveLocalMediaSource(src, page, options = {}) {
  const allowedExtensions = options.allowedExtensions || null;
  const [withoutHash] = src.split("#", 1);
  const [pathPart] = withoutHash.split("?", 1);

  if (!pathPart || isNonLocalSource(pathPart)) {
    return null;
  }

  const decodedPath = decodePathSafe(pathPart);
  const sourceDir = path.posix.dirname(page.sourceRel);
  const normalizedRelativePath = path.posix.normalize(path.posix.join(sourceDir, toPosix(decodedPath)));
  const absolutePath = path.resolve(contentDir, normalizedRelativePath);

  if (!isPathInsideRoot(absolutePath, contentDir)) {
    return null;
  }

  const extension = path.extname(pathPart).toLowerCase();
  if (allowedExtensions && !allowedExtensions.has(extension)) {
    return null;
  }

  return {
    absolutePath,
    sourceRelFromRoot: toPosix(path.relative(rootDir, absolutePath)),
    extension,
  };
}

function decodePathSafe(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function isNonLocalSource(value) {
  return value.startsWith("/") || value.startsWith("//") || /^[a-z][a-z0-9+.-]*:/i.test(value);
}

function isPathInsideRoot(candidatePath, basePath) {
  const resolvedCandidate = path.resolve(candidatePath);
  const resolvedBase = path.resolve(basePath);
  const relative = path.relative(resolvedBase, resolvedCandidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function isOptimizableRasterExtension(extension) {
  return optimizableRasterExtensions.has(extension);
}

function buildResponsiveWidths(intrinsicWidth) {
  const widths = responsiveImageWidths.filter((width) => width < intrinsicWidth);
  widths.push(intrinsicWidth);
  return [...new Set(widths)].sort((a, b) => a - b);
}

function buildSrcSet(variants, outputPath) {
  return variants
    .map((variant) => `${mediaHref(outputPath, variant.fileName)} ${variant.width}w`)
    .join(", ");
}

function mediaHref(outputPath, mediaFileName) {
  return relativeHref(outputPath, `assets/media/${mediaFileName}`);
}

function pickGifVideoWidth(intrinsicWidth) {
  const maxWidth = responsiveImageWidths[responsiveImageWidths.length - 1];
  const clamped = Math.min(intrinsicWidth, maxWidth);
  const even = clamped % 2 === 0 ? clamped : clamped - 1;
  return Math.max(2, even);
}

function pickPosterVariant(variants, preferredMaxWidth) {
  const candidate = [...variants].reverse().find((variant) => variant.width <= preferredMaxWidth);
  return candidate || variants[variants.length - 1];
}

function createMediaPipeline() {
  const imageCache = new Map();
  const gifCache = new Map();
  const videoCache = new Map();
  const generatedMediaPaths = new Set();
  let ffmpegAvailablePromise;
  let ffmpegUnavailableLogged = false;

  return {
    processImage,
    processGif,
    processVideo,
    getGeneratedPaths() {
      return [...generatedMediaPaths].sort();
    },
  };

  async function processImage(absolutePath, sourceRelFromRoot) {
    const key = `${absolutePath}:image`;
    if (!imageCache.has(key)) {
      imageCache.set(key, processImageInternal(absolutePath, sourceRelFromRoot));
    }
    return imageCache.get(key);
  }

  async function processGif(absolutePath, sourceRelFromRoot) {
    const key = `${absolutePath}:gif`;
    if (!gifCache.has(key)) {
      gifCache.set(key, processGifInternal(absolutePath, sourceRelFromRoot));
    }
    return gifCache.get(key);
  }

  async function processVideo(absolutePath, sourceRelFromRoot) {
    const key = `${absolutePath}:video`;
    if (!videoCache.has(key)) {
      videoCache.set(key, processVideoInternal(absolutePath, sourceRelFromRoot));
    }
    return videoCache.get(key);
  }

  async function processImageInternal(absolutePath, sourceRelFromRoot) {
    await fs.access(absolutePath);
    const metadata = await sharp(absolutePath, { animated: false }).metadata();

    if (!metadata.width || !metadata.height) {
      throw new Error(`Missing image dimensions for ${sourceRelFromRoot}`);
    }

    const normalized = await sharp(absolutePath, { animated: false })
      .rotate()
      .toBuffer({ resolveWithObject: true });

    const width = normalized.info.width || metadata.width;
    const height = normalized.info.height || metadata.height;
    const hasAlpha = Boolean(metadata.hasAlpha);
    const fallbackFormat = hasAlpha ? "png" : "jpg";
    const fallbackMimeType = hasAlpha ? "image/png" : "image/jpeg";
    const widths = buildResponsiveWidths(width);
    const avif = [];
    const webp = [];
    const fallback = [];

    for (const variantWidth of widths) {
      const avifBuffer = await sharp(normalized.data)
        .resize({ width: variantWidth, withoutEnlargement: true })
        .avif({ quality: 50, effort: 4 })
        .toBuffer();
      const webpBuffer = await sharp(normalized.data)
        .resize({ width: variantWidth, withoutEnlargement: true })
        .webp({ quality: 72, effort: 4 })
        .toBuffer();

      avif.push({
        width: variantWidth,
        fileName: await writeMediaBinaryAsset(sourceRelFromRoot, `w${variantWidth}`, "avif", avifBuffer),
      });

      webp.push({
        width: variantWidth,
        fileName: await writeMediaBinaryAsset(sourceRelFromRoot, `w${variantWidth}`, "webp", webpBuffer),
      });

      if (fallbackFormat === "png") {
        const pngBuffer = await sharp(normalized.data)
          .resize({ width: variantWidth, withoutEnlargement: true })
          .png({ compressionLevel: 9, adaptiveFiltering: true })
          .toBuffer();

        fallback.push({
          width: variantWidth,
          fileName: await writeMediaBinaryAsset(sourceRelFromRoot, `w${variantWidth}`, "png", pngBuffer),
        });
      } else {
        const jpegBuffer = await sharp(normalized.data)
          .resize({ width: variantWidth, withoutEnlargement: true })
          .jpeg({ quality: 82, mozjpeg: true })
          .toBuffer();

        fallback.push({
          width: variantWidth,
          fileName: await writeMediaBinaryAsset(sourceRelFromRoot, `w${variantWidth}`, "jpg", jpegBuffer),
        });
      }
    }

    return {
      kind: "image",
      width,
      height,
      avif,
      webp,
      fallback: {
        format: fallbackFormat,
        mimeType: fallbackMimeType,
        variants: fallback,
      },
    };
  }

  async function processGifInternal(absolutePath, sourceRelFromRoot) {
    const fallbackImage = await processImage(absolutePath, sourceRelFromRoot);
    const ffmpegAvailable = await isFfmpegAvailable();

    if (!ffmpegAvailable) {
      if (!ffmpegUnavailableLogged) {
        console.warn(
          "[build] ffmpeg not found on PATH; keeping GIF sources as optimized image fallbacks.",
        );
        ffmpegUnavailableLogged = true;
      }
      return fallbackImage;
    }

    const videoWidth = pickGifVideoWidth(fallbackImage.width);
    const safeBase = sanitizeMediaBaseName(sourceRelFromRoot);
    const tempToken = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
    const tempWebm = path.join(distMediaDir, `${safeBase}.${tempToken}.webm.tmp`);
    const tempMp4 = path.join(distMediaDir, `${safeBase}.${tempToken}.mp4.tmp`);

    try {
      // Keep video transforms deterministic so output hashes remain stable for caching.
      await runFfmpeg([
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-i",
        absolutePath,
        "-an",
        "-vf",
        `fps=20,scale=${videoWidth}:-2:flags=lanczos`,
        "-c:v",
        "libvpx-vp9",
        "-b:v",
        "0",
        "-crf",
        "35",
        "-pix_fmt",
        "yuv420p",
        tempWebm,
      ]);

      await runFfmpeg([
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-i",
        absolutePath,
        "-an",
        "-vf",
        `fps=20,scale=${videoWidth}:-2:flags=lanczos`,
        "-movflags",
        "+faststart",
        "-c:v",
        "libx264",
        "-crf",
        "23",
        "-pix_fmt",
        "yuv420p",
        tempMp4,
      ]);

      const [webmBuffer, mp4Buffer] = await Promise.all([
        fs.readFile(tempWebm),
        fs.readFile(tempMp4),
      ]);

      const webmFileName = await writeMediaBinaryAsset(
        sourceRelFromRoot,
        `anim-w${videoWidth}`,
        "webm",
        webmBuffer,
      );
      const mp4FileName = await writeMediaBinaryAsset(
        sourceRelFromRoot,
        `anim-w${videoWidth}`,
        "mp4",
        mp4Buffer,
      );
      const posterVariant = pickPosterVariant(fallbackImage.fallback.variants, 1024);

      return {
        kind: "video",
        width: fallbackImage.width,
        height: fallbackImage.height,
        webmFileName,
        mp4FileName,
        posterFileName: posterVariant.fileName,
      };
    } catch (error) {
      console.warn(
        `[build] GIF transcode failed for "${sourceRelFromRoot}"; using optimized image fallback instead (${error.message}).`,
      );
      return fallbackImage;
    } finally {
      await Promise.allSettled([
        fs.rm(tempWebm, { force: true }),
        fs.rm(tempMp4, { force: true }),
      ]);
    }
  }

  async function processVideoInternal(absolutePath, sourceRelFromRoot) {
    await fs.access(absolutePath);
    const extension = path.extname(absolutePath).toLowerCase();
    const ffmpegAvailable = await isFfmpegAvailable();

    if (!ffmpegAvailable) {
      if (!ffmpegUnavailableLogged) {
        console.warn(
          "[build] ffmpeg not found on PATH; keeping source video formats without transcode.",
        );
        ffmpegUnavailableLogged = true;
      }
      const originalBuffer = await fs.readFile(absolutePath);
      const originalFileName = await writeMediaBinaryAsset(
        sourceRelFromRoot,
        "orig",
        extension.slice(1),
        originalBuffer,
      );
      return {
        kind: "video-source-set",
        webmFileName: extension === ".webm" ? originalFileName : null,
        mp4FileName: extension === ".mp4" ? originalFileName : null,
        posterFileName: null,
      };
    }

    const safeBase = sanitizeMediaBaseName(sourceRelFromRoot);
    const tempToken = `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
    const tempWebm = path.join(distMediaDir, `${safeBase}.${tempToken}.webm.tmp`);
    const tempMp4 = path.join(distMediaDir, `${safeBase}.${tempToken}.mp4.tmp`);
    const tempPoster = path.join(distMediaDir, `${safeBase}.${tempToken}.poster.jpg.tmp`);

    try {
      await runFfmpeg([
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-i",
        absolutePath,
        "-an",
        "-c:v",
        "libvpx-vp9",
        "-b:v",
        "0",
        "-crf",
        "33",
        "-pix_fmt",
        "yuv420p",
        tempWebm,
      ]);

      await runFfmpeg([
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-i",
        absolutePath,
        "-an",
        "-movflags",
        "+faststart",
        "-c:v",
        "libx264",
        "-crf",
        "23",
        "-pix_fmt",
        "yuv420p",
        tempMp4,
      ]);

      await runFfmpeg([
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-i",
        absolutePath,
        "-frames:v",
        "1",
        "-q:v",
        "3",
        tempPoster,
      ]);

      const [webmBuffer, mp4Buffer, posterBuffer] = await Promise.all([
        fs.readFile(tempWebm),
        fs.readFile(tempMp4),
        fs.readFile(tempPoster),
      ]);

      const webmFileName = await writeMediaBinaryAsset(
        sourceRelFromRoot,
        "video",
        "webm",
        webmBuffer,
      );
      const mp4FileName = await writeMediaBinaryAsset(
        sourceRelFromRoot,
        "video",
        "mp4",
        mp4Buffer,
      );
      const posterFileName = await writeMediaBinaryAsset(
        sourceRelFromRoot,
        "poster",
        "jpg",
        posterBuffer,
      );

      return {
        kind: "video-source-set",
        webmFileName,
        mp4FileName,
        posterFileName,
      };
    } catch (error) {
      const originalBuffer = await fs.readFile(absolutePath);
      const originalFileName = await writeMediaBinaryAsset(
        sourceRelFromRoot,
        "orig",
        extension.slice(1),
        originalBuffer,
      );
      console.warn(
        `[build] Video transcode failed for "${sourceRelFromRoot}"; using source format only (${error.message}).`,
      );
      return {
        kind: "video-source-set",
        webmFileName: extension === ".webm" ? originalFileName : null,
        mp4FileName: extension === ".mp4" ? originalFileName : null,
        posterFileName: null,
      };
    } finally {
      await Promise.allSettled([
        fs.rm(tempWebm, { force: true }),
        fs.rm(tempMp4, { force: true }),
        fs.rm(tempPoster, { force: true }),
      ]);
    }
  }

  async function isFfmpegAvailable() {
    if (!ffmpegAvailablePromise) {
      ffmpegAvailablePromise = new Promise((resolve) => {
        const child = spawn("ffmpeg", ["-version"], { stdio: "ignore" });
        child.on("error", () => resolve(false));
        child.on("close", (code) => resolve(code === 0));
      });
    }

    return ffmpegAvailablePromise;
  }

  async function runFfmpeg(args) {
    await new Promise((resolve, reject) => {
      const child = spawn("ffmpeg", args, { stdio: ["ignore", "ignore", "pipe"] });
      let stderr = "";

      child.stderr.on("data", (chunk) => {
        stderr += chunk.toString();
        if (stderr.length > 4000) {
          stderr = stderr.slice(-4000);
        }
      });

      child.on("error", reject);
      child.on("close", (code) => {
        if (code === 0) {
          resolve();
        } else {
          reject(new Error(`ffmpeg exited with code ${code}: ${collapseWhitespace(stderr)}`));
        }
      });
    });
  }

  async function writeMediaBinaryAsset(sourceRelFromRoot, variantLabel, extension, buffer) {
    const safeBase = sanitizeMediaBaseName(sourceRelFromRoot);
    const hash = hashOf(buffer).slice(0, 10);
    const safeVariant = variantLabel.replace(/[^a-z0-9-]/gi, "").toLowerCase();
    const fileName = `${safeBase}.${safeVariant}.${hash}.${extension}`;
    const outputPath = path.join(distMediaDir, fileName);

    await fs.writeFile(outputPath, buffer);
    generatedMediaPaths.add(`assets/media/${fileName}`);

    return fileName;
  }
}

function sanitizeMediaBaseName(sourceRelFromRoot) {
  const withoutExtension = toPosix(sourceRelFromRoot).replace(/\.[a-z0-9]+$/i, "");
  const collapsed = withoutExtension
    .replace(/[^a-z0-9/_-]/gi, "-")
    .replace(/\/+/g, "/")
    .replace(/^\/+|\/+$/g, "")
    .replace(/\//g, "-")
    .replace(/-+/g, "-");

  return collapsed || "media";
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
  const serifFontHref = relativeHref(page.outputPath, "assets/fonts/IBMPlexSerif-Regular.woff2");
  const sansFontHref = relativeHref(page.outputPath, "assets/fonts/IBMPlexSans-Regular.woff2");
  const navPages = orderedPages.filter((item) => !item.navExclude);
  const navPrefetchLinks = [];
  const currentNavIndex = navPages.findIndex((item) => item.slug === page.slug);

  if (currentNavIndex > 0) {
    const previousHref = relativeHref(page.outputPath, navPages[currentNavIndex - 1].urlPath || "");
    navPrefetchLinks.push(`<link rel="prev" href="${escapeAttribute(previousHref)}">`);
    navPrefetchLinks.push(
      `<link rel="prefetch" href="${escapeAttribute(previousHref)}" as="document">`,
    );
  }

  if (currentNavIndex >= 0 && currentNavIndex < navPages.length - 1) {
    const nextHref = relativeHref(page.outputPath, navPages[currentNavIndex + 1].urlPath || "");
    navPrefetchLinks.push(`<link rel="next" href="${escapeAttribute(nextHref)}">`);
    navPrefetchLinks.push(`<link rel="prefetch" href="${escapeAttribute(nextHref)}" as="document">`);
  }

  const navPrefetchMarkup = navPrefetchLinks.length > 0 ? `${navPrefetchLinks.join("\n  ")}\n  ` : "";

  const navLinks = navPages
    .map((item) => {
      const href = relativeHref(page.outputPath, item.urlPath || "");
      const activeClass = item.slug === page.slug ? " is-active" : "";
      return `<li><a data-prefetch class="menu-link${activeClass}" href="${escapeAttribute(href)}">${escapeHtml(item.title)}</a></li>`;
    })
    .join("");

  const tocLinks = page.headings.length
    ? page.headings
        .map((heading) => {
          const indentClass = heading.depth === 3 ? " menu-link--indent" : "";
          return `<li><a class="menu-link toc-link${indentClass}" href="#${heading.id}">${escapeHtml(heading.text)}</a></li>`;
        })
        .join("")
    : '<li><span class="menu-link">No sections</span></li>';

  const title = page.urlPath ? `${page.title} | Blaze Docs` : page.title;
  const description = page.description || "Fast, static documentation template.";
  const robots = noindex ? '<meta name="robots" content="noindex">' : "";

  const firstHeading = page.headings.length > 0 ? page.headings[0].text : "Contents";
  const tocButtonText = firstHeading.length > 28 ? firstHeading.slice(0, 25) + "..." : firstHeading;

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
  <link rel="preload" href="${escapeAttribute(serifFontHref)}" as="font" type="font/woff2" crossorigin>
  <link rel="preload" href="${escapeAttribute(sansFontHref)}" as="font" type="font/woff2" crossorigin>
  ${navPrefetchMarkup}<link rel="stylesheet" href="${escapeAttribute(cssHref)}">
  <link rel="icon" href="${escapeAttribute(relativeHref(page.outputPath, "assets/favicon.svg"))}" type="image/svg+xml">
  <script type="module" src="${escapeAttribute(jsHref)}"></script>
</head>
<body>
  <a class="skip-link" href="#main-content">Skip to main content</a>
  <header class="site-header">
    <nav class="breadcrumb" aria-label="Breadcrumb">
      <a href="${escapeAttribute(relativeHref(page.outputPath, ""))}" class="breadcrumb-home" aria-label="Home">&lsaquo; &rsaquo;</a>
      <span class="breadcrumb-sep">/</span>
      <span class="breadcrumb-current">${escapeHtml(page.title)}</span>
    </nav>
    <div class="nav-pills">
      <div class="pill-wrap">
        <button class="pill-btn pill-btn--caret" data-pages-toggle type="button" aria-expanded="false">Pages</button>
        <nav class="dropdown" data-pages-dropdown aria-label="Site pages">
          <ul class="menu-list">${navLinks}</ul>
        </nav>
      </div>
      <div class="pill-wrap">
        <button class="pill-btn pill-btn--caret" data-toc-toggle type="button" aria-expanded="false">${escapeHtml(tocButtonText)}</button>
        <nav class="dropdown" data-toc-dropdown aria-label="Table of contents">
          <ul class="menu-list">${tocLinks}</ul>
        </nav>
      </div>
    </div>
    <div class="header-actions">
      <button class="pill-btn pill-btn--icon" data-reader-toggle type="button" aria-label="Reading mode">
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/></svg>
      </button>
      <button class="pill-btn pill-btn--icon" data-font-toggle type="button" aria-label="Toggle font size">
        <span class="icon-font">A</span>
      </button>
      <button class="pill-btn pill-btn--icon" data-theme-toggle type="button" aria-label="Toggle theme">
        <svg class="icon-sun" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="5"/><path d="M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42"/></svg>
        <svg class="icon-moon" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>
      </button>
      <button class="pill-btn pill-btn--icon search-toggle" data-search-toggle type="button" aria-label="Open search">
        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/></svg>
      </button>
      <div class="search-wrap" data-search-wrap>
        <label class="sr-only" for="site-search">Search documentation</label>
        <input class="input" id="site-search" data-search-input type="search" placeholder="Search" autocomplete="off" spellcheck="false">
        <button class="pill-btn pill-btn--close search-close" data-search-close type="button" aria-label="Close search">&times;</button>
        <ul class="dropdown search-results" data-search-results aria-live="polite"></ul>
      </div>
    </div>
  </header>
  <div class="site-shell">
    <main id="main-content" class="doc-panel">
      <article class="prose">
        ${page.bodyHtml}
      </article>
      <p class="doc-footer">Generated at ${escapeHtml(generatedAt)}</p>
    </main>
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
  const hash = createHash("sha256");
  if (Buffer.isBuffer(content)) {
    hash.update(content);
  } else {
    hash.update(String(content));
  }
  return hash.digest("hex");
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

function parseBoolean(value, fallback = false) {
  if (typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "true") {
      return true;
    }
    if (normalized === "false") {
      return false;
    }
  }
  return fallback;
}

async function copyDirectory(sourceDir, targetDir) {
  try {
    await fs.access(sourceDir);
  } catch {
    return [];
  }

  await fs.mkdir(targetDir, { recursive: true });
  const files = await listFilesRecursive(sourceDir);
  const copied = [];
  for (const sourceFile of files) {
    const relativeFromSource = toPosix(path.relative(sourceDir, sourceFile));
    const destinationFile = path.join(targetDir, relativeFromSource);
    await fs.mkdir(path.dirname(destinationFile), { recursive: true });
    await fs.copyFile(sourceFile, destinationFile);
    copied.push(`fonts/${relativeFromSource}`);
  }
  return copied;
}
