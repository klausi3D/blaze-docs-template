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
- Lazy, worker-based search.
- Service worker stale-while-revalidate for static assets.
- Budget checks on JS/CSS/search index size.
- Self-hosted IBM Plex fonts with `font-display: swap`.
