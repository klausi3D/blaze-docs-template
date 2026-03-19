import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, "..");

const args = parseArgs(process.argv.slice(2));
const bookId = parseBookId(args.id);
const bookTitle = parseDisplayText(args.title, "Pride and Prejudice", "title");
const bookAuthor = parseDisplayText(args.author, "Jane Austen", "author");
const targetDir = path.join(rootDir, args.target || "content/book");
const maxSections = parsePositiveNumberOrInfinity(args.maxSections, Infinity);
const paragraphsPerChapter = parsePositiveInteger(args.paragraphsPerChapter, 1);
const orderStart = parseNonNegativeInteger(args.orderStart, 120);

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

  const chapterBlocks = [];
  for (const section of sections) {
    const chapterTitle = collapseWhitespace(section.heading);
    const excerptParagraphs = extractParagraphs(section.body, paragraphsPerChapter);
    if (excerptParagraphs.length === 0) {
      continue;
    }
    chapterBlocks.push(`## ${chapterTitle}`, "");
    for (const paragraph of excerptParagraphs) {
      chapterBlocks.push(paragraph, "");
    }
  }

  const indexMd = [
    "---",
    `title: "${escapeYaml(bookTitle)} (Sample Book)"`,
    "description: \"Project Gutenberg placeholder text for typography and reading tests.\"",
    `order: ${orderStart}`,
    "slug: book",
    "search_exclude: true",
    "---",
    "",
    `# ${bookTitle}`,
    "",
    `Author: ${bookAuthor}`,
    "",
    `Source: Project Gutenberg eBook #${bookId}`,
    "",
    `This page is generated placeholder content for testing typography and long-form readability. It includes ${sections.length} chapters, each truncated to ${paragraphsPerChapter} paragraph(s).`,
    "",
    ...chapterBlocks,
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
        paragraphsPerChapter,
        targetDir: toPosix(path.relative(rootDir, targetDir)),
      },
      null,
      2,
    ),
  );
}

async function fetchGutenbergText(id) {
  const numericId = String(id);
  const candidates = [
    `https://www.gutenberg.org/cache/epub/${numericId}/pg${numericId}.txt`,
    `https://www.gutenberg.org/files/${numericId}/${numericId}-0.txt`,
    `https://www.gutenberg.org/files/${numericId}/${numericId}.txt`,
  ];
  const fetchFailures = [];
  let lastStatus = null;

  for (const url of candidates) {
    try {
      const response = await fetch(url, {
        headers: {
          "user-agent": "blaze-docs-template/0.1 (+https://github.com/klausi3D/blaze-docs-template)",
        },
      });

      lastStatus = `${response.status} ${response.statusText}`;
      if (!response.ok) {
        fetchFailures.push(`${url} -> ${lastStatus}`);
        continue;
      }

      const text = await response.text();
      if (!isLikelyBookText(text)) {
        fetchFailures.push(`${url} -> content check failed (${text.length} chars)`);
        continue;
      }

      return text;
    } catch (error) {
      fetchFailures.push(`${url} -> ${error.message}`);
    }
  }

  throw new Error(
    `Unable to fetch or validate Gutenberg text for ebook #${numericId}: ${fetchFailures.join("; ")} (last status: ${lastStatus || "n/a"})`,
  );
}

function parseBookId(rawId) {
  if (rawId === undefined) {
    return 1342;
  }

  const parsed = Number(rawId);
  if (!Number.isInteger(parsed) || parsed < 1) {
    throw new Error(`Invalid book id "${rawId}". Provide a positive integer.`);
  }
  return parsed;
}

function parsePositiveNumberOrInfinity(rawValue, fallback) {
  if (rawValue === undefined) {
    return fallback;
  }
  if (String(rawValue).trim().toLowerCase() === "infinity") {
    return Infinity;
  }

  const parsed = Number(rawValue);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`Invalid numeric value "${rawValue}".`);
  }
  return parsed;
}

function parsePositiveInteger(rawValue, fallback) {
  if (rawValue === undefined) {
    return fallback;
  }

  const parsed = Number(rawValue);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`Invalid numeric value "${rawValue}".`);
  }
  return parsed;
}

function parseNonNegativeInteger(rawValue, fallback) {
  if (rawValue === undefined) {
    return fallback;
  }

  const parsed = Number(rawValue);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`Invalid numeric value "${rawValue}".`);
  }
  return parsed;
}

function parseDisplayText(rawValue, fallback, fieldName) {
  const value = typeof rawValue === "string" ? collapseWhitespace(rawValue) : "";
  if (!value) {
    return fallback;
  }
  if (value.length > 120) {
    throw new Error(`Invalid ${fieldName}: exceeds 120 characters.`);
  }
  return value;
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

function isLikelyBookText(text) {
  const normalized = text.replace(/\r\n?/g, "\n");
  if (normalized.length < 1024) {
    return false;
  }

  return (
    /project\s+gutenberg/i.test(normalized) ||
    /\b[Gg]utenberg\s*[Ee]Book\b/.test(normalized) ||
    /\*\*\*\s*START OF/i.test(normalized)
  );
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
