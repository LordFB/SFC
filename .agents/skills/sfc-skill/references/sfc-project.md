# SFC Project Reference

## File anatomy

An SFC may contain:

```html
<template>
  <main>...</main>
</template>

<script lang="ts">
export default class extends HTMLElement {
  static tag = "shop-example";

  connectedCallback() {
    Promise.resolve().then(() => {
      // The generated template is attached by this point.
    });
  }

  disconnectedCallback() {
    // Remove external listeners and cancel outstanding work.
  }
}
</script>

<style>
shop-example main {
  display: block;
}
</style>

<route path="/shop/example" methods="GET" />
```

The transformer also supports object-style component exports, but shop components use custom-element classes. Follow the neighboring component style.

## Styling and isolation

Component CSS is injected when its module loads and can remain active after route navigation.

- A light-DOM component's ordinary `<style>` is not automatically selector-scoped.
- Prefix every light-DOM selector with its custom-element tag:

```css
shop-account h1,
shop-account h2 {
  color: #222;
}
```

- Do not write bare selectors such as `h1`, `form`, `input`, `.card`, or `.message` in a light-DOM component.
- Use `<style global>` only for intentional shared rules such as `components/GlobalStyles.sfc`.
- `static shadow = true` creates an open shadow root. Component CSS is attached inside that root, and global styles are also injected into it by the runtime.

## Lifecycle

- Route parameters are populated before the user component's `connectedCallback`.
- Defer DOM queries to a microtask when following the class-style shop pattern.
- Guard against duplicate listener attachment when a component can reconnect.
- Remove window/document listeners and abort requests in `disconnectedCallback`.
- Query `this` for light DOM and `this.shadowRoot` for shadow DOM.

## Routing and prerendering

Common declarations:

```html
<route path="/shop/products" methods="GET" />
<route path="/shop/product/:id" methods="GET" prerender="products" />
<route path="/shop/order/:id" methods="GET" prerender="skip" />
<route redirect="/shop/" method="301" />
```

Production builds reject dynamic routes without `prerender="<source>"` or `prerender="skip"`. Sources are resolved in `shop-static-routes.js`.

Only public data may enter generated route blobs. Product data is public; order and customer data must be fetched from an authenticated server API.

## Shop API and authentication

Use the shared client:

```ts
const cart = await window.shopAuth.api('/shop/api/cart', {
  body: { action: 'get' }
});
```

The shared client obtains the `HttpOnly` session cookie indirectly, attaches the CSRF token, and refreshes stale session state. Never send a `sessionId`, read authentication from local storage, or treat a route guard as authorization.

Server mutations belong in `shop-api.js`; database operations belong in `shop-db.js`. Order reads and writes must use `session.user_id`.

## Rendering safety

- Prefer `textContent` for customer-controlled values.
- Escape `&`, `<`, `>`, `"`, and `'` before interpolating values into `innerHTML`.
- Validate and normalize again on the server.
- Avoid exposing internal errors or distinguishing login failures by account existence.

## Important paths

- `src/transformer.ts`: parses SFC blocks and metadata.
- `src/plugin.ts`: development transforms, route generation, and production prerendering.
- `src/runtime/index.ts`: component definition, lifecycle, styles, and route parameters.
- `src/main.ts`: client router and lazy component loading.
- `components/GlobalStyles.sfc`: deliberate global CSS.
- `shop-api.js`: authenticated HTTP boundary.
- `shop-db.js`: SQLite schema and prepared operations.

## Verification

- Run `audit-sfc.ps1` for selector containment and dynamic-route policy.
- Run `npm.cmd test` for server/session security.
- Run `npm.cmd run build` for transforms, route declarations, prerender safety, and bundle generation.
- During development, use `npm.cmd run serve:dev`; restart it after changing server-side modules.
