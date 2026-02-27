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

## Typographic markdown examples

Use semantic markdown and keep structure explicit.[^semantics]

> Good docs are not short. They are clear, searchable, and easy to scan.
>
> - Documentation principle

### Image with visible description

```md
![System architecture](./media/architecture.png "Figure 1. Read path from CDN edge to origin.")
```

### Footnote syntax

```md
Fast docs should still support citations.[^cite]

[^cite]: Keep primary references close to the claim they support.
```

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

[^semantics]: The renderer now supports `[^id]` references and `[^id]: definition` blocks.
