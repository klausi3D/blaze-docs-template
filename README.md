# Git Pages Blaze

A performance-first documentation template for GitHub Pages.

## Goals

- Static HTML output for instant first render.
- Minimal JavaScript by default.
- Optional features loaded lazily (search index + worker).
- Hashed assets and offline cache support.
- Enforced performance budgets in CI.

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

## Content Authoring

Add markdown files in `content/`.

Front matter fields:

- `title`: page title
- `description`: optional meta description
- `order`: nav order (lower first)
- `slug`: optional output path override

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

