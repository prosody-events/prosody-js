# TypeScript examples

These examples are strict TypeScript projects, not untyped JavaScript snippets.
Opening this directory in an IDE loads `tsconfig.json`, so payload, handler, and
keyed-state types are checked at the point of use.

Run all public API and example type checks from the repository root:

```sh
yarn typecheck
```

- `keyed-state.ts` demonstrates application payload typing across a handler and
  JSON- and message-backed state.
- `windowing.ts` is the complete burst-windowing example shown in the README.
