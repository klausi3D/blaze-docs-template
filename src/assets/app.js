const rootUrl = new URL(
  document.documentElement.dataset.siteRoot || "./",
  window.location.href,
);

const resolveFromRoot = (path) => new URL(path, rootUrl).href;

const searchInput = document.querySelector("[data-search-input]");
const searchResults = document.querySelector("[data-search-results]");
const menuToggle = document.querySelector("[data-menu-toggle]");
const shell = document.querySelector("[data-site-shell]");

const state = {
  docs: null,
  inflightId: 0,
  searchInitPromise: null,
  worker: null,
  workerReady: false,
};

if (menuToggle && shell) {
  menuToggle.addEventListener("click", () => {
    shell.classList.toggle("nav-open");
  });
}

if (searchInput && searchResults) {
  searchInput.addEventListener("focus", () => {
    void ensureSearch();
  });

  searchInput.addEventListener("input", debounce(handleQuery, 80));

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
      closeResults();
    }
  });
}

if ("serviceWorker" in navigator && location.protocol === "https:") {
  window.addEventListener("load", () => {
    const swPath = document.documentElement.dataset.sw;
    if (!swPath) {
      return;
    }
    const swUrl = resolveFromRoot(swPath);
    navigator.serviceWorker.register(swUrl, { scope: rootUrl.pathname }).catch(() => {
      // Offline cache is an enhancement. Ignore registration failures.
    });
  });
}

async function handleQuery() {
  const query = searchInput.value.trim();
  if (query.length < 2) {
    closeResults();
    return;
  }

  try {
    await ensureSearch();
  } catch {
    renderEmpty("Search is unavailable.");
    return;
  }

  if (!state.worker) {
    renderEmpty("Search is unavailable.");
    return;
  }

  const requestId = ++state.inflightId;
  state.worker.postMessage({
    type: "query",
    id: requestId,
    query,
  });
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
      const response = await fetch(resolveFromRoot(indexPath));
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

  if (payload.id !== state.inflightId) {
    return;
  }

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
  searchResults.classList.remove("is-open");
}

function debounce(fn, waitMs) {
  let timeoutId = null;
  return (...args) => {
    if (timeoutId !== null) {
      window.clearTimeout(timeoutId);
    }
    timeoutId = window.setTimeout(() => fn(...args), waitMs);
  };
}
