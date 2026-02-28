const rootUrl = new URL(
  document.documentElement.dataset.siteRoot || "./",
  window.location.href,
);

const resolveFromRoot = (path) => new URL(path, rootUrl).href;
const SEARCH_MIN_QUERY_LENGTH = 2;
const SEARCH_DEBOUNCE_MS = 120;
const LINK_PREFETCH_SUPPORTED = (() => {
  const probe = document.createElement("link");
  return Boolean(probe.relList?.supports && probe.relList.supports("prefetch"));
})();

const searchInput = document.querySelector("[data-search-input]");
const searchResults = document.querySelector("[data-search-results]");
const pagesToggle = document.querySelector("[data-pages-toggle]");
const pagesDropdown = document.querySelector("[data-pages-dropdown]");
const tocToggle = document.querySelector("[data-toc-toggle]");
const tocDropdown = document.querySelector("[data-toc-dropdown]");
const searchToggle = document.querySelector("[data-search-toggle]");
const searchWrap = document.querySelector("[data-search-wrap]");
const searchClose = document.querySelector("[data-search-close]");
const themeToggle = document.querySelector("[data-theme-toggle]");
const fontToggle = document.querySelector("[data-font-toggle]");
const readerToggle = document.querySelector("[data-reader-toggle]");

const state = {
  docs: null,
  requestSeq: 0,
  activeRequestId: 0,
  searchController: null,
  searchDebounceTimer: null,
  searchInitPromise: null,
  worker: null,
  workerReady: false,
  prefetchedDocuments: new Set(),
};

// Pages dropdown toggle
if (pagesToggle && pagesDropdown) {
  pagesToggle.addEventListener("click", (event) => {
    event.stopPropagation();
    // Close TOC if open
    if (tocDropdown?.classList.contains("is-open")) {
      tocDropdown.classList.remove("is-open");
      tocToggle?.setAttribute("aria-expanded", "false");
    }
    const isOpen = pagesDropdown.classList.toggle("is-open");
    pagesToggle.setAttribute("aria-expanded", String(isOpen));
  });

  // Close on outside click
  document.addEventListener("click", (event) => {
    if (!pagesDropdown.classList.contains("is-open")) {
      return;
    }
    const target = event.target;
    if (!(target instanceof Element)) {
      return;
    }
    if (!target.closest("[data-pages-toggle]") && !target.closest("[data-pages-dropdown]")) {
      pagesDropdown.classList.remove("is-open");
      pagesToggle.setAttribute("aria-expanded", "false");
    }
  });

  // Close on link click
  pagesDropdown.querySelectorAll("a").forEach((link) => {
    link.addEventListener("click", () => {
      pagesDropdown.classList.remove("is-open");
      pagesToggle.setAttribute("aria-expanded", "false");
    });
  });

  // Close on Escape
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && pagesDropdown.classList.contains("is-open")) {
      pagesDropdown.classList.remove("is-open");
      pagesToggle.setAttribute("aria-expanded", "false");
      pagesToggle.focus();
    }
  });
}

// TOC dropdown toggle
if (tocToggle && tocDropdown) {
  tocToggle.addEventListener("click", (event) => {
    event.stopPropagation();
    // Close Pages if open
    if (pagesDropdown?.classList.contains("is-open")) {
      pagesDropdown.classList.remove("is-open");
      pagesToggle?.setAttribute("aria-expanded", "false");
    }
    const isOpen = tocDropdown.classList.toggle("is-open");
    tocToggle.setAttribute("aria-expanded", String(isOpen));
  });

  // Close on outside click
  document.addEventListener("click", (event) => {
    if (!tocDropdown.classList.contains("is-open")) {
      return;
    }
    const target = event.target;
    if (!(target instanceof Element)) {
      return;
    }
    if (!target.closest("[data-toc-toggle]") && !target.closest("[data-toc-dropdown]")) {
      tocDropdown.classList.remove("is-open");
      tocToggle.setAttribute("aria-expanded", "false");
    }
  });

  // Close on link click
  tocDropdown.querySelectorAll("a").forEach((link) => {
    link.addEventListener("click", () => {
      tocDropdown.classList.remove("is-open");
      tocToggle.setAttribute("aria-expanded", "false");
    });
  });

  // Close on Escape
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && tocDropdown.classList.contains("is-open")) {
      tocDropdown.classList.remove("is-open");
      tocToggle.setAttribute("aria-expanded", "false");
      tocToggle.focus();
    }
  });
}

// Mobile search toggle
if (searchToggle && searchWrap && searchClose) {
  searchToggle.addEventListener("click", () => {
    searchWrap.classList.add("is-expanded");
    searchInput?.focus();
  });

  searchClose.addEventListener("click", () => {
    searchWrap.classList.remove("is-expanded");
    if (searchInput) {
      searchInput.value = "";
    }
    if (searchResults) {
      searchResults.classList.remove("is-open");
      searchResults.innerHTML = "";
    }
  });

  // Close on Escape
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && searchWrap.classList.contains("is-expanded")) {
      searchWrap.classList.remove("is-expanded");
      searchToggle.focus();
    }
  });
}

// Theme toggle
if (themeToggle) {
  const stored = localStorage.getItem("theme");
  if (stored) document.documentElement.setAttribute("data-theme", stored);
  themeToggle.addEventListener("click", () => {
    const current = document.documentElement.getAttribute("data-theme");
    const prefersDark = matchMedia("(prefers-color-scheme: dark)").matches;
    const isDark = current === "dark" || (!current && prefersDark);
    const next = isDark ? "light" : "dark";
    document.documentElement.setAttribute("data-theme", next);
    localStorage.setItem("theme", next);
  });
}

// Font size toggle
if (fontToggle) {
  const stored = localStorage.getItem("font");
  if (stored) document.documentElement.setAttribute("data-font", stored);
  fontToggle.addEventListener("click", () => {
    const isLarge = document.documentElement.getAttribute("data-font") === "large";
    const next = isLarge ? "normal" : "large";
    document.documentElement.setAttribute("data-font", next);
    localStorage.setItem("font", next);
  });
}

// Reader mode
if (readerToggle) {
  const modes = ["", "immersive", "paginated"];
  let modeIndex = 0;
  let lastScroll = 0;
  let readerContainer = null;

  readerToggle.addEventListener("click", () => {
    modeIndex = (modeIndex + 1) % modes.length;
    const mode = modes[modeIndex];
    if (mode) {
      document.documentElement.setAttribute("data-reader", mode);
      if (mode === "paginated") initPaginated();
    } else {
      document.documentElement.removeAttribute("data-reader");
      destroyPaginated();
    }
  });

  // Immersive: hide header on scroll down
  window.addEventListener("scroll", () => {
    if (document.documentElement.getAttribute("data-reader") !== "immersive") return;
    const y = window.scrollY;
    if (y > lastScroll && y > 60) document.documentElement.classList.add("header-hidden");
    else document.documentElement.classList.remove("header-hidden");
    lastScroll = y;
  }, { passive: true });

  function initPaginated() {
    const prose = document.querySelector(".prose");
    if (!prose || readerContainer) return;
    readerContainer = document.createElement("div");
    readerContainer.className = "reader-container";
    readerContainer.innerHTML = `<div class="reader-content"><div class="reader-page"></div></div><nav class="reader-nav"><button data-prev>← Prev</button><span class="reader-progress"></span><button data-next>Next →</button></nav>`;
    document.body.appendChild(readerContainer);
    const page = readerContainer.querySelector(".reader-page");
    page.innerHTML = prose.innerHTML;
    setupPagination();
  }

  function destroyPaginated() {
    if (readerContainer) { readerContainer.remove(); readerContainer = null; }
  }

  function setupPagination() {
    const content = readerContainer.querySelector(".reader-content");
    const page = readerContainer.querySelector(".reader-page");
    const progress = readerContainer.querySelector(".reader-progress");
    const prevBtn = readerContainer.querySelector("[data-prev]");
    const nextBtn = readerContainer.querySelector("[data-next]");
    let current = 0, total = 1;

    const update = () => {
      const w = content.clientWidth - 48;
      page.style.columnWidth = w + "px";
      total = Math.ceil(page.scrollWidth / w);
      current = Math.min(current, total - 1);
      page.style.transform = `translateX(-${current * w}px)`;
      progress.textContent = `${current + 1} / ${total}`;
      prevBtn.disabled = current === 0;
      nextBtn.disabled = current >= total - 1;
    };

    prevBtn.onclick = () => { if (current > 0) { current--; update(); } };
    nextBtn.onclick = () => { if (current < total - 1) { current++; update(); } };
    window.addEventListener("resize", update);
    update();
  }
}

// Scroll-spy for TOC highlighting
setupScrollSpy();

setupRoutePrefetch();

setupFootnoteTooltips();

if (searchInput && searchResults) {
  searchInput.addEventListener("focus", () => {
    void ensureSearch();
  });

  searchInput.addEventListener("input", scheduleSearchQuery);

  document.addEventListener("click", (event) => {
    const target = event.target;
    if (!(target instanceof Node)) {
      return;
    }
    if (searchResults.contains(target) || searchInput.contains(target)) {
      return;
    }
    closeResults();
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      cancelActiveSearch();
      closeResults();
    }
  });
}

if ("serviceWorker" in navigator && location.protocol === "https:") {
  const reloadFlag = "blaze-sw-controller-reloaded";
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    try {
      if (sessionStorage.getItem(reloadFlag) === "1") {
        return;
      }
      sessionStorage.setItem(reloadFlag, "1");
    } catch {
      // Ignore storage failures and continue with reload.
    }
    window.location.reload();
  });

  window.addEventListener("load", () => {
    const swPath = document.documentElement.dataset.sw;
    if (!swPath) {
      return;
    }
    const swUrl = resolveFromRoot(swPath);
    navigator.serviceWorker
      .register(swUrl, { scope: rootUrl.pathname })
      .then(async (registration) => {
        if (registration.waiting) {
          registration.waiting.postMessage({ type: "SKIP_WAITING" });
        }

        registration.addEventListener("updatefound", () => {
          const installing = registration.installing;
          if (!installing) {
            return;
          }

          installing.addEventListener("statechange", () => {
            if (installing.state === "installed" && navigator.serviceWorker.controller) {
              installing.postMessage({ type: "SKIP_WAITING" });
            }
          });
        });

        await registration.update();
      })
      .catch(() => {
        // Offline cache is an enhancement. Ignore registration failures.
      });
  });
}

function scheduleSearchQuery() {
  if (!searchInput) {
    return;
  }

  const query = searchInput.value.trim();
  if (state.searchDebounceTimer !== null) {
    window.clearTimeout(state.searchDebounceTimer);
    state.searchDebounceTimer = null;
  }

  if (query.length < SEARCH_MIN_QUERY_LENGTH) {
    cancelActiveSearch();
    closeResults();
    return;
  }

  state.searchDebounceTimer = window.setTimeout(() => {
    state.searchDebounceTimer = null;
    void runSearchQuery(query);
  }, SEARCH_DEBOUNCE_MS);
}

async function runSearchQuery(query) {
  if (!searchInput || !searchResults) {
    return;
  }

  const latestQuery = searchInput.value.trim();
  if (query !== latestQuery || query.length < SEARCH_MIN_QUERY_LENGTH) {
    return;
  }

  cancelActiveSearch();
  const controller = new AbortController();
  state.searchController = controller;
  const requestId = ++state.requestSeq;
  state.activeRequestId = requestId;

  try {
    await ensureSearch();
  } catch {
    if (!controller.signal.aborted) {
      renderEmpty("Search is unavailable.");
    }
    return;
  }

  if (controller.signal.aborted || requestId !== state.activeRequestId) {
    return;
  }

  if (!state.worker) {
    renderEmpty("Search is unavailable.");
    return;
  }

  state.worker.postMessage({
    type: "query",
    id: requestId,
    query,
  });
}

function cancelActiveSearch() {
  if (state.searchController) {
    state.searchController.abort();
    state.searchController = null;
  }
  state.activeRequestId = ++state.requestSeq;
}

async function ensureSearch() {
  if (state.workerReady) {
    return;
  }

  if (state.searchInitPromise) {
    return state.searchInitPromise;
  }

  state.searchInitPromise = (async () => {
    const workerPath = document.documentElement.dataset.searchWorker;
    const indexPath = document.documentElement.dataset.searchIndex;
    if (!workerPath || !indexPath) {
      throw new Error("Search paths missing");
    }

    if (!state.docs) {
      const response = await fetch(resolveFromRoot(indexPath), { cache: "force-cache" });
      if (!response.ok) {
        throw new Error(`Search index failed with ${response.status}`);
      }
      state.docs = await response.json();
    }

    if (!state.worker) {
      state.worker = new Worker(resolveFromRoot(workerPath), { type: "module" });
      state.worker.addEventListener("message", onWorkerMessage);
    }

    await new Promise((resolve, reject) => {
      const timeout = window.setTimeout(() => {
        reject(new Error("Search worker timeout"));
      }, 5000);

      const onReady = (event) => {
        const payload = event.data;
        if (!payload || payload.type !== "ready") {
          return;
        }
        window.clearTimeout(timeout);
        state.worker.removeEventListener("message", onReady);
        state.workerReady = true;
        resolve();
      };

      state.worker.addEventListener("message", onReady);
      state.worker.postMessage({ type: "init", docs: state.docs });
    });
  })();

  try {
    await state.searchInitPromise;
  } finally {
    state.searchInitPromise = null;
  }
}

function onWorkerMessage(event) {
  const payload = event.data;
  if (!payload || payload.type !== "results") {
    return;
  }

  if (payload.id !== state.activeRequestId) {
    return;
  }

  if (state.searchController?.signal.aborted) {
    return;
  }
  state.searchController = null;

  const results = Array.isArray(payload.results) ? payload.results : [];
  if (results.length === 0) {
    renderEmpty("No matches.");
    return;
  }

  const fragment = document.createDocumentFragment();
  for (const item of results) {
    const li = document.createElement("li");
    const link = document.createElement("a");
    link.href = resolveFromRoot(item.url);

    const title = document.createElement("span");
    title.className = "result-title";
    title.textContent = item.title;

    const snippet = document.createElement("span");
    snippet.className = "result-snippet";
    snippet.textContent = item.snippet;

    link.append(title, snippet);
    li.append(link);
    fragment.append(li);
  }

  searchResults.replaceChildren(fragment);
  searchResults.classList.add("is-open");
}

function renderEmpty(message) {
  const li = document.createElement("li");
  const text = document.createElement("span");
  text.className = "search-empty";
  text.textContent = message;
  li.append(text);
  searchResults.replaceChildren(li);
  searchResults.classList.add("is-open");
}

function closeResults() {
  if (!searchResults) {
    return;
  }
  searchResults.classList.remove("is-open");
}

function setupRoutePrefetch() {
  const links = Array.from(document.querySelectorAll("a[data-prefetch]"));
  if (links.length === 0) {
    return;
  }

  for (const link of links) {
    if (!(link instanceof HTMLAnchorElement)) {
      continue;
    }
    const href = normalizePrefetchHref(link.href);
    if (!href) {
      continue;
    }

    const prefetchOnIntent = () => {
      prefetchDocument(href);
    };

    link.addEventListener("mouseenter", prefetchOnIntent, { passive: true });
    link.addEventListener("focus", prefetchOnIntent, { passive: true });
    link.addEventListener(
      "touchstart",
      () => {
        prefetchDocument(href);
      },
      { passive: true, once: true },
    );
  }
}

function normalizePrefetchHref(inputHref) {
  if (!inputHref) {
    return null;
  }

  let parsed;
  try {
    parsed = new URL(inputHref, window.location.href);
  } catch {
    return null;
  }

  if (parsed.origin !== window.location.origin) {
    return null;
  }

  parsed.hash = "";
  const current = new URL(window.location.href);
  current.hash = "";
  if (parsed.href === current.href) {
    return null;
  }

  return parsed.href;
}

function prefetchDocument(href) {
  if (!href || state.prefetchedDocuments.has(href)) {
    return;
  }
  state.prefetchedDocuments.add(href);

  if (LINK_PREFETCH_SUPPORTED) {
    const prefetch = document.createElement("link");
    prefetch.rel = "prefetch";
    prefetch.as = "document";
    prefetch.href = href;
    document.head.append(prefetch);
    return;
  }

  void fetch(href, { credentials: "same-origin" }).catch(() => {
    // Ignore prefetch failures.
  });
}

function setupScrollSpy() {
  // Get all TOC links (both in sidebar TOC and dropdown)
  const tocLinks = document.querySelectorAll(".toc-link");
  if (tocLinks.length === 0) {
    return;
  }

  // Build map of heading IDs to their TOC links
  const headingIds = [];
  const linksByHeadingId = new Map();

  tocLinks.forEach((link) => {
    const href = link.getAttribute("href");
    if (!href || !href.startsWith("#")) {
      return;
    }
    const id = href.slice(1);
    headingIds.push(id);
    if (!linksByHeadingId.has(id)) {
      linksByHeadingId.set(id, []);
    }
    linksByHeadingId.get(id).push(link);
  });

  if (headingIds.length === 0) {
    return;
  }

  // Get all headings that match TOC entries
  const headings = headingIds
    .map((id) => document.getElementById(id))
    .filter((el) => el !== null);

  if (headings.length === 0) {
    return;
  }

  let currentActiveId = null;

  function setActiveHeading(id) {
    if (id === currentActiveId) {
      return;
    }

    // Remove active from previous
    if (currentActiveId && linksByHeadingId.has(currentActiveId)) {
      linksByHeadingId.get(currentActiveId).forEach((link) => {
        link.classList.remove("is-active");
      });
    }

    // Add active to new
    if (id && linksByHeadingId.has(id)) {
      linksByHeadingId.get(id).forEach((link) => {
        link.classList.add("is-active");
      });
    }

    currentActiveId = id;

    // Update TOC toggle button text with current section
    if (tocToggle && id) {
      const activeLinks = linksByHeadingId.get(id);
      if (activeLinks && activeLinks.length > 0) {
        const sectionTitle = activeLinks[0].textContent?.trim();
        if (sectionTitle && sectionTitle.length < 30) {
          tocToggle.textContent = sectionTitle;
        } else if (sectionTitle) {
          tocToggle.textContent = sectionTitle.slice(0, 27) + "…";
        }
      }
    }
  }

  // Use IntersectionObserver to track visible headings
  const observerOptions = {
    root: null,
    rootMargin: "-80px 0px -70% 0px", // Trigger when heading is in top 30% of viewport
    threshold: 0,
  };

  const observer = new IntersectionObserver((entries) => {
    // Find the topmost visible heading
    let topmostEntry = null;

    entries.forEach((entry) => {
      if (entry.isIntersecting) {
        if (!topmostEntry || entry.boundingClientRect.top < topmostEntry.boundingClientRect.top) {
          topmostEntry = entry;
        }
      }
    });

    if (topmostEntry) {
      setActiveHeading(topmostEntry.target.id);
    }
  }, observerOptions);

  headings.forEach((heading) => {
    observer.observe(heading);
  });

  // Set initial active based on scroll position
  const initialHeading = headings.find((heading) => {
    const rect = heading.getBoundingClientRect();
    return rect.top >= 0 && rect.top < window.innerHeight * 0.5;
  });

  if (initialHeading) {
    setActiveHeading(initialHeading.id);
  } else if (headings.length > 0) {
    // Default to first heading if none visible
    setActiveHeading(headings[0].id);
  }
}

function setupFootnoteTooltips() {
  let active = null;
  let timer = null;

  document.querySelectorAll(".footnote-ref").forEach((ref) => {
    const link = ref.querySelector("a[href^='#fn-']");
    if (!link) return;

    const fn = document.getElementById(link.getAttribute("href").slice(1));
    if (!fn) return;

    const clone = fn.cloneNode(true);
    clone.querySelectorAll(".footnote-backrefs").forEach((el) => el.remove());
    const html = clone.innerHTML.trim();

    ref.addEventListener("mouseenter", () => {
      clearTimeout(timer);
      active?.remove();
      const tip = document.createElement("div");
      tip.className = "footnote-tooltip";
      tip.innerHTML = html;
      ref.appendChild(tip);
      requestAnimationFrame(() => {
        const r = tip.getBoundingClientRect();
        if (r.left < 8) { tip.style.left = "0"; tip.style.transform = "none"; }
        else if (r.right > innerWidth - 8) { tip.style.left = "auto"; tip.style.right = "0"; tip.style.transform = "none"; }
        tip.classList.add("is-visible");
      });
      active = tip;
    });

    ref.addEventListener("mouseleave", () => {
      timer = setTimeout(() => { active?.remove(); active = null; }, 100);
    });
  });
}
