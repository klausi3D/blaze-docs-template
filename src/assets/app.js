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
const menuToggle = document.querySelector("[data-menu-toggle]");
const gridToggle = document.querySelector("[data-grid-toggle]");
const shell = document.querySelector("[data-site-shell]");
const tocToggle = document.querySelector("[data-toc-toggle]");
const tocDropdown = document.querySelector("[data-toc-dropdown]");
const searchToggle = document.querySelector("[data-search-toggle]");
const searchWrap = document.querySelector("[data-search-wrap]");
const searchClose = document.querySelector("[data-search-close]");
const gridStorageKey = "blaze-grid-debug";

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

if (menuToggle && shell) {
  menuToggle.addEventListener("click", () => {
    shell.classList.toggle("nav-open");
  });

  // Close menu when clicking nav links
  const navLinks = shell.querySelectorAll(".nav-link");
  navLinks.forEach((link) => {
    link.addEventListener("click", () => {
      shell.classList.remove("nav-open");
    });
  });

  // Close menu when clicking backdrop (outside sidebar)
  document.addEventListener("click", (event) => {
    if (!shell.classList.contains("nav-open")) {
      return;
    }
    const target = event.target;
    if (!(target instanceof Element)) {
      return;
    }
    const isInsideSidebar = target.closest(".sidebar");
    const isMenuToggle = target.closest("[data-menu-toggle]");
    if (!isInsideSidebar && !isMenuToggle) {
      shell.classList.remove("nav-open");
    }
  });

  // Close menu on Escape key
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && shell.classList.contains("nav-open")) {
      shell.classList.remove("nav-open");
      menuToggle.focus();
    }
  });
}

// TOC dropdown toggle
if (tocToggle && tocDropdown) {
  tocToggle.addEventListener("click", (event) => {
    event.stopPropagation();
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

setupGridDebug();
setupRoutePrefetch();

if (searchInput && searchResults) {

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

function setupGridDebug() {
  const params = new URLSearchParams(window.location.search);
  const forcedOn = params.get("grid") === "1";
  const forcedOff = params.get("grid") === "0";
  let enabled = false;

  if (forcedOn) {
    enabled = true;
  } else if (forcedOff) {
    enabled = false;
  } else {
    enabled = readGridPreference();
  }

  applyGridDebug(enabled);

  if (gridToggle) {
    gridToggle.addEventListener("click", () => {
      const nextEnabled = !document.body.classList.contains("grid-debug");
      applyGridDebug(nextEnabled);
      writeGridPreference(nextEnabled);
    });
  }

  document.addEventListener("keydown", (event) => {
    if (!event.altKey || event.key.toLowerCase() !== "g") {
      return;
    }
    event.preventDefault();
    const nextEnabled = !document.body.classList.contains("grid-debug");
    applyGridDebug(nextEnabled);
    writeGridPreference(nextEnabled);
  });
}

function applyGridDebug(enabled) {
  document.body.classList.toggle("grid-debug", enabled);
  if (gridToggle) {
    gridToggle.setAttribute("aria-pressed", enabled ? "true" : "false");
    gridToggle.textContent = enabled ? "Grid On" : "Grid";
  }
}

function readGridPreference() {
  try {
    return localStorage.getItem(gridStorageKey) === "1";
  } catch {
    return false;
  }
}

function writeGridPreference(enabled) {
  try {
    localStorage.setItem(gridStorageKey, enabled ? "1" : "0");
  } catch {
    // Ignore storage write failures.
  }
}
