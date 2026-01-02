# SFC Framework

A lightweight Vite plugin that transforms Single-File Components (`.sfc`) into native Web Components (Custom Elements). Write clean, declarative components with familiar Vue-like syntax while generating zero-dependency vanilla Custom Elements.

[![Made with Vite](https://img.shields.io/badge/Made%20with-Vite-646CFF?style=flat-square&logo=vite)](https://vitejs.dev/)
[![TypeScript](https://img.shields.io/badge/TypeScript-3178C6?style=flat-square&logo=typescript&logoColor=white)](https://www.typescriptlang.org/)

## Features

- 🚀 **Native Web Components** - Compiles to standard Custom Elements with no runtime framework
- 📦 **Single-File Components** - `<template>`, `<script>`, `<style>`, and `<route>` blocks in one file
- 🎨 **Shadow DOM Support** - Optional style encapsulation with `shadow: true`
- 🔧 **TypeScript Decorators** - `@click`, `@input`, `@change`, `@debounce`, `@throttle`
- 🛣️ **File-Based Routing** - Automatic route generation from `<route>` blocks
- ⚡ **Hot Module Replacement** - Full HMR support for templates, styles, and scripts
- 🎯 **Template Interpolation** - `{{ param }}` syntax with automatic route/query param binding
- 💅 **SCSS Support** - Built-in Sass preprocessing with `lang="scss"`
- 🔗 **Auto-Imports** - Automatically imports nested components with dashed tags

## Installation

```bash
npm install
```

## Quick Start

```bash
# Start development server
npm run dev

# Run production server
npm run serve
```

## Component Syntax

### Object-Based (Simple)

```html
<template>
  <div class="example">
    <h3>Hello World</h3>
    <p>User ID: {{ id }}</p>
  </div>
</template>

<script lang="ts">
export default {
  tag: 'x-example',
  shadow: true,
  connectedCallback() {
    console.log('Connected with params:', this.params);
  }
};
</script>

<style>
.example {
  padding: 12px;
  border: 1px solid #ddd;
}
</style>

<route path="/example/:id" methods="GET,POST" />
```

### Class-Based (With Decorators)

```html
<template>
  <input class="search-input" type="text" placeholder="Search..." />
  <button class="submit-btn">Submit</button>
</template>

<script lang="ts">
export default class extends HTMLElement {
  static tag = 'x-search';

  @input('.search-input')
  @debounce(300)
  onSearch(e) {
    console.log('Search:', e.target.value);
  }

  @click('.submit-btn')
  onSubmit(e) {
    console.log('Submitted!');
  }
}
</script>

<style>
.search-input {
  padding: 8px;
  border: 1px solid #ccc;
}
.submit-btn {
  padding: 8px 16px;
}
</style>
```

## Decorators

| Decorator | Description |
|-----------|-------------|
| `@click(selector)` | Binds click event to matching elements |
| `@input(selector)` | Binds input event to matching elements |
| `@change(selector)` | Binds change event to matching elements |
| `@debounce(ms)` | Debounces method execution by specified milliseconds |
| `@throttle(ms)` | Throttles method to once per specified milliseconds |

**Example with timing decorators:**

```typescript
@input('.search-box')
@debounce(300)
handleSearch(e) {
  // Only fires 300ms after user stops typing
  this.performSearch(e.target.value);
}

@click('.scroll-handler')
@throttle(100)
handleScroll() {
  // Fires at most once every 100ms
  this.updateScrollPosition();
}
```

## Routing

Define routes directly in your component with the `<route>` block:

```html
<route path="/users/:id" methods="GET,POST" lazy="component" />
```

Route parameters are automatically extracted and available via `this.params`:

```typescript
connectedCallback() {
  console.log(this.params.id);  // Route param from /users/:id
}
```

Access all routes programmatically:

```typescript
import routes from 'virtual:routes';
// Returns array of route definitions with path, methods, paramNames, etc.
```

## Template Interpolation

Use `{{ param }}` syntax to interpolate route and query parameters:

```html
<template>
  <h1>User Profile</h1>
  <p>User ID: {{ id }}</p>
  <p>Tab: {{ tab }}</p>
</template>

<!-- For URL: /users/123?tab=settings -->
<!-- Renders: User ID: 123, Tab: settings -->
```

## Styling

### Scoped Styles (Shadow DOM)

```html
<script>
export default {
  tag: 'x-component',
  shadow: true  // Styles are encapsulated
};
</script>

<style>
/* Only affects this component */
.button { color: blue; }
</style>
```

### Global Styles

```html
<style global>
/* Applied to document, not shadow DOM */
body { font-family: sans-serif; }
</style>
```

### SCSS Support

```html
<style lang="scss">
.container {
  padding: 1rem;
  
  .nested {
    color: blue;
    
    &:hover {
      color: red;
    }
  }
}
</style>
```

## Architecture

The framework uses a 3-stage pipeline:

1. **Transformer** (`src/transformer.ts`) - Regex extracts blocks → generates JS module via MagicString
2. **Plugin** (`src/plugin.ts`) - Handles virtual modules, Babel decorator preprocessing, route manifest
3. **Runtime** (`src/runtime/index.ts`) - `defineComponent()` registers elements, wires decorators, manages styles

## Project Structure

```
├── components/          # Your .sfc components
│   ├── Home.sfc
│   ├── User.sfc
│   └── shop/           # Nested components
├── src/
│   ├── main.ts         # Application entry
│   ├── plugin.ts       # Vite plugin
│   ├── transformer.ts  # SFC parser
│   └── runtime/        # Browser runtime
├── vite.config.ts
└── index.html
```

## Scripts

| Command | Description |
|---------|-------------|
| `npm run dev` | Start dev server with HMR on port 5173 |
| `npm run build` | Production build to `dist/` |
| `npm run serve` | Run production server (server.js) |

## Browser Support

Works in all modern browsers that support:
- Custom Elements v1
- Shadow DOM v1
- ES2020+

## License

MIT
