---
title: Performance Playbook
order: 3
description: Non-negotiable rules for a snappy docs site.
---

# Performance Playbook

## Non-negotiables

1. Keep JavaScript optional.
2. Never ship third-party scripts on core docs pages.
3. Enforce budgets in CI and fail hard.
4. Prefer plain HTML/CSS over framework hydration.

## Optional advanced tactics

- Serve through a CDN in front of GitHub Pages for stronger caching headers.
- Generate Brotli-compressed artifacts in CI for CDN origin pull.
- Add synthetic monitoring with Lighthouse CI and WebPageTest.

## Red flags

- Client-side markdown rendering.
- Full-text search that blocks initial page load.
- Large icon/font bundles.
- Analytics scripts on every page without strict sampling.
