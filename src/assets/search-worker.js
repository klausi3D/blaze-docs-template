let docs = [];

self.addEventListener("message", (event) => {
  const payload = event.data;
  if (!payload || typeof payload.type !== "string") {
    return;
  }

  if (payload.type === "init") {
    docs = normalizeDocs(payload.docs);
    self.postMessage({ type: "ready" });
    return;
  }

  if (payload.type === "query") {
    const results = runSearch(String(payload.query || ""));
    self.postMessage({
      type: "results",
      id: payload.id,
      results,
    });
  }
});

function normalizeDocs(source) {
  if (!Array.isArray(source)) {
    return [];
  }

  return source.map((doc) => {
    const title = String(doc.title || "");
    const snippet = String(doc.excerpt || "");
    const body = normalize(`${title} ${doc.headings || ""} ${doc.text || ""}`);
    return {
      title,
      snippet,
      url: String(doc.url || ""),
      body,
    };
  });
}

function runSearch(query) {
  const cleaned = normalize(query);
  if (cleaned.length < 2 || docs.length === 0) {
    return [];
  }

  const terms = cleaned.split(" ").filter(Boolean);
  const scored = [];

  for (const doc of docs) {
    let score = 0;
    for (const term of terms) {
      if (doc.body.includes(term)) {
        score += 1;
      }
      if (normalize(doc.title).includes(term)) {
        score += 4;
      }
    }
    if (score > 0) {
      scored.push({
        score,
        title: doc.title,
        url: doc.url,
        snippet: doc.snippet,
      });
    }
  }

  scored.sort((a, b) => b.score - a.score || a.title.localeCompare(b.title));
  return scored.slice(0, 8);
}

function normalize(text) {
  return String(text)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}
