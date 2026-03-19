# Contributing

Thanks for contributing to `git-pages-blaze`.

## Development Setup

1. Install Node.js 20+.
2. Install dependencies:

```bash
npm install
```

3. Run the main quality gates locally:

```bash
npm run ci
```

4. Run browser smoke tests locally:

```bash
npm run e2e
```

## Pull Request Checklist

- Keep changes scoped and focused.
- Ensure `npm run ci` passes.
- Ensure `npm run e2e` passes for UI-affecting changes.
- Add or update docs when behavior changes.
- Include clear PR notes describing what changed and why.

## Commit Guidance

- Use descriptive commit messages.
- Prefer small commits with a single intent.
- Do not commit generated output from `dist/`.
