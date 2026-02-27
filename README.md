# Git Pages Blaze

A performance-first documentation template for GitHub Pages.

## Goals

- Static HTML output for instant first render.
- Minimal JavaScript by default.
- Optional features loaded lazily (search index + worker).
- Hashed assets and offline cache support.
- Enforced performance budgets in CI.
- Typographic rhythm with IBM Plex Serif/Sans/Mono and baseline-aligned spacing.

## Quick Start

1. Install dependencies:

```bash
npm install
```

2. Build the site:

```bash
npm run build
```

3. Verify budgets:

```bash
npm run check:budgets
```

4. Preview locally:

```bash
npm run preview
```

5. Generate placeholder long-form content from Project Gutenberg:

```bash
npm run seed:book
```

This creates a single page at `content/book/index.md` with one section per chapter (`## Chapter ...`), so chapter links appear in the page TOC. By default, it keeps one paragraph per chapter for fast loads.

Grid debug mode is available in the UI (`Grid` button in top bar), with keyboard shortcut `Alt+G`, or by appending `?grid=1` to any URL.

## Content Authoring

Add markdown files in `content/`.

Front matter fields:

- `title`: page title
- `description`: optional meta description
- `order`: nav order (lower first)
- `slug`: optional output path override
- `nav_exclude`: optional boolean to hide a page from sidebar navigation
- `search_exclude`: optional boolean to remove a page from generated search index

`index.md` maps to `/`.
Every other page maps to `/your-slug/`.

## Deployment

GitHub Actions workflow is in `.github/workflows/deploy.yml`.
It builds `dist/` and deploys with GitHub Pages Actions (not Jekyll).

## Performance Defaults

- No frameworks.
- No icon/font libraries.
- Pre-rendered pages.
- Lazy, worker-based search with debounced + cancelable query flow.
- Selective document prefetch (previous/next page and link-intent prefetch).
- Service worker stale-while-revalidate for static assets.
- Budget checks on raw and Brotli-compressed transfer sizes.
- Self-hosted IBM Plex fonts with `font-display: swap`.
