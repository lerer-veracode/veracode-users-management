# Code standards

## General

1. Keep it simple, do not overcomplicate.
2. Comments only when necessary.
3. Be concise: a short README and no emojis.
4. IMPORTANT: avoid overly defensive code. Handle errors only when necessary.

## TypeScript

5. Strict mode, never `any`. Use `unknown` and narrow it when a type is truly unknown.
6. Prefer `type` for shapes and unions; use `interface` only when it must be extended.
7. No non-null assertions (`!`) or `as` casts to silence the compiler; fix the types instead.
8. ES modules, named exports, `const` by default, `async`/`await` over raw promises.
9. Validate data at the boundaries (API responses, form input, env vars) once, then trust the types inside.
10. Use npm: ALWAYS `npm run <script>` for build, test, lint and dev. Lint and type-check must pass with no warnings.

## UI

11. Function components and hooks only, no class components.
12. One component per file, named in PascalCase to match the file.
13. Keep components small: move data fetching and logic into hooks or plain functions, leave components to render.
14. Keep state as local as possible; lift it only when siblings need it. Derive values instead of storing them.
15. Styling follows `docs/BRAND.md`: use the shared tokens and components, never hard-coded colours or one-off styles.
16. Accessible by default: semantic HTML, labels on every input, keyboard navigable, visible focus.
17. Every view handles its loading, empty and error states.
18. Test behaviour the user sees, not implementation details.
