import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, "..");

const args = parseArgs(process.argv.slice(2));
const bookId = args.id || "1342";
const bookTitle = args.title || "Pride and Prejudice";
const bookAuthor = args.author || "Jane Austen";
const targetDir = path.join(rootDir, args.target || "content/book");
const maxSections = args.maxSections ? Number(args.maxSections) : Infinity;
const orderStart = args.orderStart ? Number(args.orderStart) : 120;

if (maxSections !== Infinity && (!Number.isFinite(maxSections) || maxSections <= 0)) {
  throw new Error("maxSections must be a positive number");
}

await importBook();

async function importBook() {
  const source = await fetchGutenbergText(bookId);
  const body = stripGutenbergBoilerplate(source);
  const sections = splitIntoSections(body)
    .slice(0, maxSections)
    .map((section, index) => ({
      ...section,
      index: index + 1,
      slug: `chapter-${String(index + 1).padStart(2, "0")}`,
    }));

  if (sections.length === 0) {
    throw new Error("No chapter-like sections were found in the selected Gutenberg text");
  }

  await fs.rm(targetDir, { recursive: true, force: true });
  await fs.mkdir(targetDir, { recursive: true });

  const chapterLinks = [];

  for (const section of sections) {
    const chapterTitle = collapseWhitespace(section.heading);
    const chapterBody = toMarkdownParagraphs(section.body);
    const fileName = `${section.slug}.md`;
    const frontMatter = [
      "---",
      `title: \"${escapeYaml(`${bookTitle} - ${chapterTitle}`)}\"`,
      `description: \"${escapeYaml(`Placeholder excerpt from ${bookTitle}`)}\"`,
      `order: ${orderStart + section.index}`,
      `slug: book/${section.slug}`,
      "nav_exclude: true",
      "search_exclude: true",
      "---",
      "",
    ].join("\n");

    const markdown = `${frontMatter}# ${chapterTitle}\n\n${chapterBody}\n`;
    await fs.writeFile(path.join(targetDir, fileName), markdown, "utf8");
    chapterLinks.push(`- [${chapterTitle}](./${fileName})`);
  }

  const previewSection = sections[0];
  const previewParagraphs = extractParagraphs(previewSection.body, 7);
  const previewBlocks = [];
  for (const paragraph of previewParagraphs) {
    previewBlocks.push(paragraph, "");
  }

  const indexMd = [
    "---",
    `title: \"${escapeYaml(bookTitle)} (Sample Book)\"`,
    "description: \"Project Gutenberg placeholder text for typography and reading tests.\"",
    `order: ${orderStart}`,
    "slug: book",
    "---",
    "",
    `# ${bookTitle}`,
    "",
    `Author: ${bookAuthor}`,
    "",
    `Source: Project Gutenberg eBook #${bookId}`,
    "",
    "This section is generated placeholder content for testing documentation readability, rhythm, and long-form layout.",
    "",
    "## Reading sample",
    "",
    `### ${previewSection.heading}`,
    "",
    ...previewBlocks,
    `[Continue chapter 1](./${sections[0].slug}.md)`,
    "",
    "## Chapters",
    "",
    ...chapterLinks,
    "",
  ].join("\n");

  await fs.writeFile(path.join(targetDir, "index.md"), indexMd, "utf8");

  console.log(
    JSON.stringify(
      {
        id: bookId,
        title: bookTitle,
        author: bookAuthor,
        chapters: sections.length,
        targetDir: toPosix(path.relative(rootDir, targetDir)),
      },
      null,
      2,
    ),
  );
}

async function fetchGutenbergText(id) {
  const candidates = [
    `https://www.gutenberg.org/cache/epub/${id}/pg${id}.txt`,
    `https://www.gutenberg.org/files/${id}/${id}-0.txt`,
    `https://www.gutenberg.org/files/${id}/${id}.txt`,
  ];

  for (const url of candidates) {
    const response = await fetch(url, {
      headers: {
        "user-agent": "blaze-docs-template/0.1 (+https://github.com/klausi3D/blaze-docs-template)",
      },
    });

    if (!response.ok) {
      continue;
    }

    const text = await response.text();
    if (text.length > 0) {
      return text;
    }
  }

  throw new Error(`Unable to fetch Gutenberg text for ebook #${id}`);
}

function stripGutenbergBoilerplate(rawText) {
  const normalized = rawText.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  const startPattern = /\*\*\*\s*START OF (?:THE|THIS) PROJECT GUTENBERG EBOOK[\s\S]*?\*\*\*/i;
  const endPattern = /\*\*\*\s*END OF (?:THE|THIS) PROJECT GUTENBERG EBOOK[\s\S]*?\*\*\*/i;

  const startMatch = normalized.match(startPattern);
  const endMatch = normalized.match(endPattern);

  const startIndex = startMatch ? startMatch.index + startMatch[0].length : 0;
  const endIndex = endMatch ? endMatch.index : normalized.length;

  return normalized.slice(startIndex, endIndex).trim();
}

function splitIntoSections(bookBody) {
  const pattern = /^(chapter\s+(?:\d+|[ivxlcdm]+)\b[^\n]*|letter\s+(?:\d+|[ivxlcdm]+)\b[^\n]*)\s*$/gim;
  const matches = [...bookBody.matchAll(pattern)];

  if (matches.length < 2) {
    return [{ heading: "Book Excerpt", body: bookBody }];
  }

  const sections = [];
  for (let index = 0; index < matches.length; index += 1) {
    const current = matches[index];
    const start = current.index + current[0].length;
    const nextStart = index + 1 < matches.length ? matches[index + 1].index : bookBody.length;
    const heading = current[1].trim();
    const body = bookBody.slice(start, nextStart).trim();

    if (!body) {
      continue;
    }

    sections.push({ heading: normalizeHeading(heading), body });
  }

  return sections;
}

function normalizeHeading(value) {
  const cleaned = collapseWhitespace(value.replaceAll("[", "").replaceAll("]", ""));
  if (/^chapter\b/i.test(cleaned)) {
    return cleaned.replace(/^chapter\b/i, "Chapter");
  }
  if (/^letter\b/i.test(cleaned)) {
    return cleaned.replace(/^letter\b/i, "Letter");
  }
  return cleaned;
}

function toMarkdownParagraphs(text) {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const blocks = [];
  let paragraph = [];

  const flushParagraph = () => {
    if (paragraph.length === 0) {
      return;
    }
    blocks.push(paragraph.join(" ").replace(/\s+/g, " ").trim());
    paragraph = [];
  };

  for (const rawLine of lines) {
    const line = rawLine.trim();

    if (!line) {
      flushParagraph();
      continue;
    }

    if (isDiscardLine(line)) {
      continue;
    }

    if (isStandaloneHeading(line)) {
      flushParagraph();
      blocks.push(`## ${toTitleCase(line.toLowerCase())}`);
      continue;
    }

    paragraph.push(line);
  }

  flushParagraph();

  return blocks.join("\n\n");
}

function extractParagraphs(text, maxParagraphs) {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const paragraphs = [];
  let chunk = [];

  const flush = () => {
    if (chunk.length === 0) {
      return;
    }
    const paragraph = chunk.join(" ").replace(/\s+/g, " ").trim();
    if (paragraph.length > 0) {
      paragraphs.push(paragraph);
    }
    chunk = [];
  };

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) {
      flush();
      if (paragraphs.length >= maxParagraphs) {
        break;
      }
      continue;
    }

    if (isDiscardLine(line) || isStandaloneHeading(line)) {
      continue;
    }

    chunk.push(line);
  }

  flush();
  return paragraphs.slice(0, maxParagraphs);
}

function isStandaloneHeading(line) {
  if (line.length < 4 || line.length > 64) {
    return false;
  }

  if (!/[A-Z]/.test(line)) {
    return false;
  }

  const lettersOnly = line.replace(/[^A-Za-z]/g, "");
  return lettersOnly.length > 0 && lettersOnly === lettersOnly.toUpperCase();
}

function isDiscardLine(line) {
  if (/^\[illustration[:\]]?/i.test(line)) {
    return true;
  }
  if (/^\[_?copyright/i.test(line)) {
    return true;
  }
  if (/^\[[^\]]+\]$/.test(line) && /(illustration|copyright)/i.test(line)) {
    return true;
  }
  return false;
}

function toTitleCase(value) {
  return value
    .split(" ")
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

function collapseWhitespace(value) {
  return value.replace(/\s+/g, " ").trim();
}

function escapeYaml(value) {
  return String(value).replaceAll('"', '\\"');
}

function parseArgs(argv) {
  const parsed = {};

  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith("--")) {
      continue;
    }

    const key = token.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) {
      parsed[key] = "true";
      continue;
    }

    parsed[key] = next;
    i += 1;
  }

  return parsed;
}

function toPosix(value) {
  return value.split(path.sep).join(path.posix.sep);
}
