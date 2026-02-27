---
title: Getting Started
order: 2
description: How to customize and ship this blazing-fast template.
---

# Getting Started

## Install dependencies

```bash
npm install
```

## Build the site

```bash
npm run build
```

## Check performance budgets

```bash
npm run check:budgets
```

## Add your docs

Create markdown files in `content/`.

### Front matter example

```yaml
---
title: API Reference
order: 5
description: Endpoint and SDK reference.
slug: api
---
```

## Deploy

Push to `main` and enable GitHub Pages to use GitHub Actions as source.
