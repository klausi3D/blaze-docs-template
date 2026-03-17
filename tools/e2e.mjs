import { promises as fs, createReadStream } from "node:fs";
import path from "node:path";
import { createServer, request } from "node:http";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const rootDir = path.dirname(__filename);
const repoDir = path.resolve(rootDir, "..");
const distDir = path.join(repoDir, "dist");
const outputDir = path.join(repoDir, "output", "playwright");
const appUrl = process.env.APP_URL || "http://localhost:4173";
const appUrlObj = new URL(appUrl);
const appPort = Number(appUrlObj.port || (appUrlObj.protocol === "https:" ? 443 : 80));
const appHost = appUrlObj.hostname || "localhost";
const routes = ["/", "/getting-started/", "/performance-playbook/", "/book/", "/does-not-exist/"];
const viewports = [
  { name: "desktop", width: 1280, height: 720 },
  { name: "mobile", width: 390, height: 844 },
];

const { chromium } = await loadPlaywright();

await fs.mkdir(outputDir, { recursive: true });

const preview = await ensurePreviewServer();
try {
  const browser = await chromium.launch({
    headless: true,
    args: ["--disable-dev-shm-usage", "--disable-gpu", "--no-sandbox"],
  });

  let failed = false;
  try {
    for (const viewport of viewports) {
      const context = await browser.newContext({
        viewport,
        userAgent: "Mozilla/5.0 (A11Y-Check)",
      });

      for (const route of routes) {
        const page = await context.newPage();
        const pageLabel = safeLabel(route);
        const errors = [];
        const pageErrors = [];

        page.on("console", (message) => {
          if (message.type() === "error") {
            errors.push(message.text());
          }
        });
        page.on("pageerror", (error) => {
          pageErrors.push(error.message || String(error));
        });

        try {
          await context.tracing.start({ screenshots: true, snapshots: true, sources: true });
          await navigateToRoute(page, route);
          await validateRouteBasics(page, route);

          await runInteractionSmoke(page);

          if (route === "/") {
            await runSearchErrorPath(page);
          }

          await runSmokeScreenshot(page, `${viewport.name}-${pageLabel}-${Date.now()}`);

          if (route !== "/does-not-exist/") {
            const unexpectedErrors = [...errors, ...pageErrors].filter((entry) => {
              if (route === "/") {
                return !/search-index|404|ERR_FAILED|Failed to fetch/.test(entry);
              }
              return !/404/.test(entry);
            });
            if (unexpectedErrors.length > 0) {
              throw new Error(`Unexpected console/page errors on ${route}: ${unexpectedErrors[0]}`);
            }
          }
        } catch (error) {
          const tracePath = path.join(outputDir, `route-fail-${viewport.name}-${pageLabel}.zip`);
          await page.screenshot({ path: path.join(outputDir, `route-fail-${viewport.name}-${pageLabel}.png`) });
          await context.tracing.stop({ path: tracePath }).catch(() => {});
          console.error(`E2E failed for ${route} (${viewport.name}): ${error.message}`);
          failed = true;
        } finally {
          await context.tracing.stop().catch(() => {});
          await page.close();
        }
      }

      await context.close();
    }
  } finally {
    await browser.close();
  }

  if (failed) {
    process.exit(1);
  }

  console.log("Playwright smoke passed.");
} finally {
  if (preview) {
    await preview.close();
  }
}

async function ensurePreviewServer() {
  if (await isReachable(`${appUrl}/`)) {
    return null;
  }

  const handler = async (request, response) => {
    const targetCandidates = resolveDistCandidates(new URL(request.url, appUrl).pathname);

    for (const candidate of targetCandidates) {
      const candidatePath = path.resolve(distDir, candidate);
      if (!candidatePath.startsWith(`${distDir}${path.sep}`) && candidatePath !== distDir) {
        continue;
      }

      try {
        await fs.access(candidatePath);
        const stream = createReadStream(candidatePath);
        response.setHeader("Content-Type", getContentType(candidatePath));
        response.statusCode = 200;
        stream.pipe(response);
        return;
      } catch {
        // try next candidate.
      }
    }

    response.statusCode = 404;
    response.setHeader("Content-Type", "text/plain; charset=utf-8");
    response.end("Not Found");
  };

  const server = createServer(handler);
  await new Promise((resolve, reject) => {
    const onError = (error) => {
      server.off("error", onError);
      reject(error);
    };
    server.once("error", onError);
    server.listen(appPort, appHost, () => {
      server.off("error", onError);
      resolve();
    });
  });

  const ready = await waitForUrl(`${appUrl}/`, 10000);
  if (!ready) {
    await new Promise((resolve) => server.close(resolve));
    throw new Error(`Failed to start preview at ${appUrl}`);
  }

  return {
    close: () =>
      new Promise((resolve) => {
        server.close(() => resolve());
      }),
  };
}

async function loadPlaywright() {
  try {
    const playwrightModule = await import("playwright");
    return playwrightModule;
  } catch {
    console.error("Playwright dependency is missing. Install it with: npm install -D playwright");
    process.exit(1);
  }
}

function resolveDistCandidates(pathname) {
  let normalized = decodeURIComponent((pathname || "/").replace(/\/+$/, ""));
  if (normalized === "") {
    normalized = "/";
  }

  const withoutLeading = normalized.replace(/^\/+/, "");
  const candidates = new Set();

  if (withoutLeading === "") {
    candidates.add("index.html");
  } else if (normalized.endsWith("/")) {
    candidates.add(`${withoutLeading}/index.html`);
  } else if (!path.extname(withoutLeading)) {
    candidates.add(`${withoutLeading}.html`);
    candidates.add(`${withoutLeading}/index.html`);
  } else {
    candidates.add(withoutLeading);
  }

  if (!normalized.endsWith("/")) {
    candidates.add(`${withoutLeading}/index.html`);
    candidates.add(`${withoutLeading}.html`);
  }

  return [...candidates];
}

function getContentType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".html") return "text/html; charset=utf-8";
  if (ext === ".css") return "text/css; charset=utf-8";
  if (ext === ".js") return "application/javascript; charset=utf-8";
  if (ext === ".json") return "application/json; charset=utf-8";
  if (ext === ".svg") return "image/svg+xml";
  if (ext === ".png") return "image/png";
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".webp") return "image/webp";
  if (ext === ".woff2") return "font/woff2";
  if (ext === ".gif") return "image/gif";
  return "application/octet-stream";
}

async function isReachable(url) {
  return checkUrlResponse(url);
}

async function waitForUrl(url, timeoutMs) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (await checkUrlResponse(url)) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return false;
}

async function checkUrlResponse(url) {
  return new Promise((resolve) => {
    const requestObj = request(url, (response) => {
      response.resume();
      response.on("end", () => resolve(response.statusCode === 200));
    });
    requestObj.on("error", () => resolve(false));
    requestObj.setTimeout(500, () => {
      requestObj.destroy(new Error("timeout"));
      resolve(false);
    });
    requestObj.end();
  });
}

async function navigateToRoute(page, route) {
  const response = await page.goto(`${appUrl}${route}`, {
    waitUntil: "domcontentloaded",
    timeout: 15000,
  });

  if (!response) {
    throw new Error(`No response for ${route}`);
  }

  if (route === "/does-not-exist/") {
    if (response.status() !== 404) {
      throw new Error(`Expected 404 for ${route}, got ${response.status()}`);
    }
    await page.waitForLoadState("networkidle");
    return;
  }

  if (response.status() >= 400) {
    throw new Error(`Unexpected status ${response.status()} for ${route}`);
  }

  await page.waitForLoadState("networkidle");
}

async function validateRouteBasics(page, route) {
  if (route === "/does-not-exist/") {
    const text = await page.locator("body").textContent();
    const normalized = text ? text.toLowerCase() : "";
    if (!normalized.includes("404") && !normalized.includes("not found")) {
      throw new Error("404 response body does not indicate missing page");
    }
    return;
  }

  const main = page.locator("main");
  if ((await main.count()) === 0) {
    throw new Error(`Missing main landmark on ${route}`);
  }

  const nav = page.locator("nav");
  if ((await nav.count()) === 0) {
    throw new Error(`Missing nav landmark on ${route}`);
  }

  const skipLink = page.locator(".skip-link, a[href='#main-content']");
  if ((await skipLink.count()) === 0) {
    throw new Error(`Missing skip link on ${route}`);
  }

  const heading = page.locator("h1");
  if ((await heading.count()) === 0) {
    throw new Error(`No heading on ${route}`);
  }

  const keyboardReachable = await page.evaluate(() => {
    const first = document.querySelector("a, button, input, [tabindex='0']");
    return Boolean(first);
  });
  if (!keyboardReachable) {
    throw new Error(`No keyboard focusable controls on ${route}`);
  }
}

async function runInteractionSmoke(page) {
  const readerToggle = page.locator("[data-reader-toggle]");
  if (await readerToggle.count()) {
    await readerToggle.click();
    await page.waitForFunction(() => document.documentElement.getAttribute("data-reader") === "immersive");
    await readerToggle.click();
    await page.waitForFunction(() => document.documentElement.getAttribute("data-reader") === "paginated");
    await readerToggle.click();
    await page.waitForFunction(() => !document.documentElement.hasAttribute("data-reader"));
  }

  const pagesToggle = page.locator("[data-pages-toggle]");
  if (await pagesToggle.count()) {
    await pagesToggle.click();
    await page.waitForFunction(() => {
      const button = document.querySelector("[data-pages-toggle]");
      return button && button.getAttribute("aria-expanded") === "true";
    });
    await page.keyboard.press("Escape");
  }

  const tocToggle = page.locator("[data-toc-toggle]");
  if (await tocToggle.count()) {
    await tocToggle.click();
    await page.waitForFunction(() => {
      const button = document.querySelector("[data-toc-toggle]");
      return button && button.getAttribute("aria-expanded") === "true";
    });
    await page.keyboard.press("Escape");
  }

  await page.keyboard.press("Tab");
  const focusedElementTag = await page.evaluate(() => document.activeElement?.tagName?.toLowerCase());
  if (!focusedElementTag) {
    throw new Error("Keyboard tab navigation did not focus an element");
  }
}

async function runSearchErrorPath(page) {
  const routeInput = page.locator("[data-search-input]");
  const searchToggle = page.locator("[data-search-toggle]");

  if (await routeInput.count() === 0) {
    return;
  }

  await page.evaluate(() => {
    const root = document.documentElement;
    root.dataset.searchIndex = "/assets/search-index-does-not-exist.json";
  });

  if (!(await routeInput.isVisible())) {
    await page.keyboard.press("/");

    if (!(await routeInput.isVisible()) && (await searchToggle.count()) && (await searchToggle.isVisible())) {
      await searchToggle.click();
    }
  }

  if (!(await routeInput.isVisible())) {
    throw new Error("Search input is not visible after opening search UI.");
  }

  const hasSearchResults = page.locator("[data-search-results]");
  await routeInput.fill("ab", { force: true });
  await page.waitForFunction(() => {
    const results = document.querySelector("[data-search-results]");
    return Boolean(results && results.children.length > 0);
  });

  if ((await hasSearchResults.count()) > 0) {
    const emptyResults = hasSearchResults.locator(".search-empty");
    if ((await emptyResults.count()) === 0) {
      const text = await hasSearchResults.innerText();
      throw new Error(`Search fallback message was not displayed on fetch failure: ${JSON.stringify(text.slice(0, 300))}`);
    }

    const message = (await emptyResults.first().innerText()).trim();
    if (!/Search is (temporarily )?unavailable|Search response is invalid|Search is unavailable/.test(message)) {
      throw new Error(`Unexpected search error message on fetch failure: ${JSON.stringify(message)}`);
    }
  }

  await page.evaluate(() => {
    const root = document.documentElement;
    delete root.dataset.searchIndex;
  });
}

async function runSmokeScreenshot(page, suffix) {
  const screenshotPath = path.join(outputDir, `smoke-${suffix}.png`);
  try {
    await page.screenshot({ path: screenshotPath, fullPage: true });
  } catch {
    // screenshot optional for resilience
  }
}

function safeLabel(route) {
  if (route === "/") {
    return "home";
  }
  return route.replace(/\//g, "_").replace(/^_+|_+$/g, "");
}
