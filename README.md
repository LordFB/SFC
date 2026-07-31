# SFC Framework Showcase

A living manual, feature showcase, playground, and performance lab for this
repository's custom `.sfc` framework. Components compile to native custom
elements and keep templates, scripts, styles, routes, and server handlers close
together without a virtual DOM.

## Explore the framework

| Route | Chapter | Focus |
| --- | --- | --- |
| `/basics` | Framework basics | Templates, bindings, events, scoped styles, and component composition |
| `/intermediate` | Backend introduction | Route handlers, secure data adapters, validation, and JSON responses |
| `/advanced` | Full stack | SQLite-backed reactive values, SSE fan-out, and lifecycle cleanup |
| `/internals` | Framework internals | Parse, transform, route discovery, lazy loading, and custom-element mounting |
| `/playground` | SFC Playground | Self-hosted Monaco editor with a sandboxed, live component preview |
| `/stress-testing` | Performance lab | Concurrent writes, pub/sub latency, p95 response time, and persistence checks |

The root route redirects to `/basics`. The old `/testing` URL remains as a
compatibility redirect to `/stress-testing`.

## Quick start

```bash
npm install
npm run serve:dev
```

Open <http://localhost:5173>. Changes to `.sfc` files are transformed on demand
by the development server.

## Build and preview

```bash
npm run build
npm run serve:preview
```

Preview mode serves the production output on loopback without requiring public
authentication configuration. A real production process fails closed unless
the relying-party settings are supplied:

```bash
AUTH_ORIGIN=https://docs.example.com \
AUTH_RP_ID=docs.example.com \
npm run serve
```

PowerShell:

```powershell
$env:AUTH_ORIGIN = 'https://docs.example.com'
$env:AUTH_RP_ID = 'docs.example.com'
npm run serve
```

## SFC anatomy

```html
<template>
  <button @click="increment">Count: {{ count }}</button>
</template>

<script>
import { SFCComponent } from '/src/runtime'

export default class Counter extends SFCComponent {
  static tag = 'demo-counter'
  count = 0

  increment() {
    this.count += 1
  }
}
</script>

<style>
demo-counter button { font: inherit; }
</style>

<route path="/counter" methods="GET" />
```

The transformer extracts each block, compiles the component module and template
bindings, scopes CSS, and exposes route metadata. The client router discovers
route components through `import.meta.glob`, then loads only the component for
the current URL.

## Realtime values

`realtimeValue()` connects an SFC field to a persistent SQLite key. Writes are
committed through the server and fanned out over Server-Sent Events; subscribers
receive versioned updates and the component unsubscribes during teardown. The
advanced chapter demonstrates the API, while the stress lab measures concurrent
writes, persistence, event delivery, and end-to-end latency in the browser.

## Data adapters

`data-adapters.js` keeps outbound service connections on the server side. It
provides opaque environment/file secrets, HTTP adapters with bearer, basic,
API-key, OAuth2 client-credentials, and mutual-TLS configuration, plus managed
OpenSSH tunnels for services reachable through a bastion. `createDataLayer()`
exposes only named operations; each operation must validate input and explicitly
declare authorization or `public: true`.

Copy `.env.example` to `.env.local` for local credentials. The serve and build
commands load `.env`, `.env.local`, `.env.<mode>`, and
`.env.<mode>.local`; variables already present in the process take precedence.
All real `.env` variants are ignored by Git.

## Commands

```bash
npm test             # framework, API, auth, realtime, and concurrency tests
npm run build        # validate routes and emit dist/public
npm run serve:dev    # transform components on demand
npm run serve:preview
npm run serve        # hardened production mode
```

## Repository map

```text
components/docs/        Documentation chapters, shared shell, and visual system
components/Testing.sfc  Browser stress and performance lab
src/runtime/            Custom-element runtime and reactive realtime client
src/transformer.ts      SFC block extraction and compilation
src/plugin.ts           Vite integration, route discovery, and prerender output
data-adapters.js         Server-only adapters, secrets, auth, and SSH transport
env-loader.js            Layered local .env loading with process-env precedence
realtime-db.js          SQLite values, versions, subscriptions, and SSE fan-out
server.js               Development transform/API server
server.prod.js          Production/preview static and API server
test/                    Unit, integration, security, and load-oriented tests
```
