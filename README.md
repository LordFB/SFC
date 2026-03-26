# SFC Framework

A Vite plugin that compiles Single-File Components into native [Web Components](https://developer.mozilla.org/en-US/docs/Web/API/Web_components) (Custom Elements). Familiar `.sfc` syntax — `<template>`, `<script>`, `<style>`, `<route>` — zero-dependency output.

[![Made with Vite](https://img.shields.io/badge/Vite-5-646CFF?style=flat-square&logo=vite)](https://vitejs.dev/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5-3178C6?style=flat-square&logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow?style=flat-square)](LICENSE)

---

## Why?

Most component frameworks carry a runtime. SFC compiles away at build time: the browser gets plain Custom Elements, standard DOM APIs, no virtual DOM, no diffing. The result is a thin layer over what the platform already provides.

## Getting Started

```bash
npm install
npm run dev          # Vite dev server at http://localhost:5173
npm run dev:shop     # Shop API server at http://localhost:5174 (optional, for the demo shop)
```

Open [http://localhost:5173/shop](http://localhost:5173/shop) to see the included demo app.

## Quick Example

```html
<!-- components/Counter.sfc -->
<template>
  <div class="counter">
    <p>Count: <span class="count">0</span></p>
    <button class="inc">+1</button>
  </div>
</template>

<script lang="ts">
export default class extends HTMLElement {
  static tag = 'x-counter';
  n = 0;

  @click('.inc')
  increment() {
    this.n++;
    this.querySelector('.count')!.textContent = String(this.n);
  }
}
</script>

<style lang="scss">
.counter {
  padding: 1rem;
  button { margin-top: 0.5rem; }
}
</style>

<route path="/counter" />
```

That's it — a routable Web Component with scoped styles and declarative event binding.

## Component Syntax

Every `.sfc` file can contain four blocks:

| Block | Purpose |
|---|---|
| `<template>` | HTML markup. Supports `{{ param }}` interpolation for route/query params. |
| `<script lang="ts">` | Component logic. Export an object or a class extending `HTMLElement`. |
| `<style>` | CSS (or SCSS with `lang="scss"`). Add `global` attribute for document-level styles. |
| `<route>` | Declares the URL path, HTTP methods, and routing behaviour. |

### Object API

Best for simple, presentational components:

```html
<script lang="ts">
export default {
  tag: 'x-greeting',
  shadow: true,
  connectedCallback() {
    console.log('Mounted with params:', this.params);
  }
};
</script>
```

### Class API

For components with event handling, decorators, and richer logic:

```html
<script lang="ts">
export default class extends HTMLElement {
  static tag = 'x-search';

  @input('.search-box')
  @debounce(300)
  onSearch(e) {
    console.log('Search:', e.target.value);
  }

  @click('.clear-btn')
  onClear() {
    this.querySelector('.search-box').value = '';
  }
}
</script>
```

## Decorators

Decorators bind DOM events and apply timing transforms — no manual `addEventListener` / `removeEventListener` needed. Listeners are automatically cleaned up on disconnect.

| Decorator | Description |
|---|---|
| `@click(selector?)` | Bind click events. Selector is optional; defaults to the component itself. |
| `@input(selector?)` | Bind input events. |
| `@change(selector?)` | Bind change events. |
| `@submit(selector?)` | Bind submit events. |
| `@debounce(ms)` | Delay execution until `ms` after last call. Stack with event decorators. |
| `@throttle(ms)` | Limit execution to once per `ms`. Stack with event decorators. |

```html
<script lang="ts">
export default class extends HTMLElement {
  static tag = 'x-form';

  @input('.email')
  @debounce(400)
  validateEmail(e) { /* fires 400ms after user stops typing */ }

  @click('.save')
  @throttle(1000)
  save() { /* at most once per second */ }
}
</script>
```

## Routing

### Declaring Routes

Add a `<route>` block to any component:

```html
<!-- Static path -->
<route path="/about" />

<!-- Dynamic params -->
<route path="/users/:id" />

<!-- Multiple HTTP methods (enables server-side POST handling) -->
<route path="/contact" methods="GET,POST" />

<!-- Redirect -->
<route redirect="/shop/" method="301" />
```

Routes are collected at build time from all `.sfc` files and exposed as a virtual module:

```ts
import { routes } from 'virtual:routes';
```

### Route Parameters & Query Strings

Parameters are parsed automatically and available in `connectedCallback` via `this.params`:

```html
<template>
  <h1>User {{ id }}</h1>
  <p>Tab: {{ tab }}</p>
</template>

<script lang="ts">
export default {
  tag: 'x-user',
  connectedCallback() {
    // URL: /users/42?tab=settings
    console.log(this.params.id);   // "42"
    console.log(this.params.tab);  // "settings"
  }
};
</script>

<route path="/users/:id" />
```

### SPA Navigation

The client-side router intercepts `<a>` clicks, supports `popstate`, and uses the [View Transition API](https://developer.mozilla.org/en-US/docs/Web/API/View_Transition_API) when available. Links are preloaded on hover for instant navigation.

## Styling

### Scoped (Shadow DOM)

Set `shadow: true` to encapsulate styles:

```html
<script>
export default { tag: 'x-card', shadow: true };
</script>

<style>
/* Only affects this component's shadow tree */
p { color: blue; }
</style>
```

### Global Styles

Use the `global` attribute to inject styles into the document:

```html
<style global>
:root { --accent: #667eea; }
body { font-family: sans-serif; }
</style>
```

Global styles are also injected into shadow roots so themed components stay consistent.

### SCSS

```html
<style lang="scss">
.card {
  padding: 1rem;
  &__title { font-weight: bold; }
  &:hover { box-shadow: 0 4px 12px rgba(0,0,0,0.1); }
}
</style>
```

## Server-Side POST Handlers

Components with `methods="GET,POST"` can export a `postHandler` that runs on the server during development:

```html
<script lang="ts">
export default {
  tag: 'x-contact',
  postHandler(body, req, res) {
    // Runs server-side in Node.js
    return {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
      body: { message: 'Received', data: body }
    };
  }
};
</script>

<route path="/contact" methods="GET,POST" />
```

Handler-only components (no `<template>`, no `tag`) are purely server-side and produce no client-side code.

## Auto-Imports

Dashed custom element tags used in `<template>` are automatically resolved to their `.sfc` files:

```html
<template>
  <!-- Resolves to components/shop/Nav.sfc (tag: shop-nav) -->
  <shop-nav></shop-nav>
  <main>...</main>
</template>
```

No manual imports needed — the transformer scans the components directory and injects side-effect imports.

## Production Build

Build the frontend and run a standalone server that includes the shop API:

```bash
npm run build       # Vite production build → dist/public/
npm run start       # Standalone Node.js server on port 3000
```

The production server provides:

- Static file serving with Brotli/gzip compression
- ETag-based caching (`304` responses) and immutable hashing for assets
- SPA fallback for client-side routes
- Integrated API endpoints (no separate API server needed)

Set `PORT` environment variable to change the default port:

```bash
PORT=8080 npm run start
```

## Project Structure

```
├── components/              # .sfc components
│   ├── GlobalStyles.sfc     # Document-level global styles
│   ├── Home.sfc             # Redirect route (/ → /shop/)
│   ├── NotFound.sfc         # 404 page
│   ├── shop/                # Shop demo app
│   │   ├── Index.sfc
│   │   ├── Products.sfc
│   │   ├── Cart.sfc
│   │   └── api/             # Server-only POST handlers
│   ├── site/                # Documentation pages
│   └── tetris/              # Tetris game demo
├── src/
│   ├── main.ts              # SPA router & entry point
│   ├── plugin.ts            # Vite plugin
│   ├── transformer.ts       # .sfc → JS compiler
│   ├── runtime/index.ts     # defineComponent, attachStyles, decorators
│   └── cache.ts             # LRU transform cache with disk persistence
├── server.prod.js           # Production server
├── shop-db.js               # SQLite database (demo shop)
├── vite.config.ts            # Dev config
├── vite.config.build.ts      # Production build config
└── index.html
```

## All Scripts

| Command | Description |
|---|---|
| `npm run dev` | Dev server with HMR (port 5173) |
| `npm run dev:shop` | Shop API server (port 5174) |
| `npm run dev:prod` | Dev server with production-like optimizations |
| `npm run build` | Production build to `dist/public/` |
| `npm run start` | Production server (port 3000) |
| `npm run serve` | Legacy JIT dev server |

## How It Works

1. **Transformer** — Regex-extracts `<template>`, `<script>`, `<style>`, `<route>` blocks from `.sfc` files. Generates a JS module that calls `defineComponent()` to register a Custom Element.
2. **Plugin** — Vite plugin that hooks into `transform` (compile `.sfc`), `load` (handle `?sfc-script` virtual imports with Babel decorator preprocessing), and `resolveId` (serve `virtual:routes`). Also wires up server-side POST handler middleware.
3. **Runtime** — `defineComponent()` registers the Custom Element, attaches templates via cached `DocumentFragment` cloning, wires decorator metadata to event listeners, manages Shadow DOM, injects global/local styles via `adoptedStyleSheets`, and cleans up on disconnect.

## Browser Support

Requires:
- Custom Elements v1
- Shadow DOM v1 (optional per component)
- ES2022+
- View Transition API (optional, graceful fallback)

## License

MIT
