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

Preview mode serves the production output on loopback. A production process
uses the same built assets and binds according to `HOST` and `PORT`:

```bash
HOST=0.0.0.0 PORT=5173 \
npm run serve
```

PowerShell:

```powershell
$env:HOST = '0.0.0.0'
$env:PORT = '5173'
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
bindings, attaches component CSS, and exposes route metadata. Production routes
contain real template HTML, first-paint CSS, and an exact module preload. The
client router discovers route components through `import.meta.glob`, then loads
only the component for the current URL and upgrades the existing DOM in place.

Routes can declare a persistent custom-element layout. Production emits its
Shadow DOM declaratively, so the complete layout and page render before the
runtime loads:

```html
<route path="/guides" methods="GET"
       layout="docs-shell" layout-section="guides" />
```

## Realtime values

`realtimeValue()` connects an SFC field to a persistent SQLite key. This
showcase exposes only the `docs/advanced/*`, `testing/showcase/*`, and
`testing/benchmark/*` namespaces in production. Mutations require an exact
same-origin request; subscribers receive versioned updates and components
unsubscribe during teardown.

Production builds scan executable component scripts for active public realtime
keys, then remove obsolete values and event history from that public scope. Data
owned by other authorization scopes is left untouched.

## Data adapters

`data-adapters.js` keeps outbound service connections on the server side. It
provides opaque environment/file secrets, HTTP adapters with bearer, basic,
API-key, OAuth2 client-credentials, and mutual-TLS configuration, plus managed
OpenSSH tunnels for services reachable through a bastion. `createDataLayer()`
exposes only named operations; each operation must validate input and explicitly
declare authorization or `public: true`.

Database persistence uses the asynchronous contract in `database/contract.js`.
Application modules issue portable `$1`-parameterized SQL and depend only on
`query`, `get`, `execute`, `exec`, and `transaction`; drivers own connection and
dialect details. `SFC_SQL_ADAPTER=sqlite` selects the local `better-sqlite3`
adapter and `SFC_SQLITE_PATH` selects its file. When no explicit adapter is set,
the presence of Netlify's runtime environment selects the `@netlify/database`
Postgres adapter automatically. Netlify applies the baseline schema from
`netlify/database/migrations/` to production and deploy-preview branches.

Copy `.env.example` to `.env.local` for local credentials. The serve and build
commands load `.env`, `.env.local`, `.env.<mode>`, and
`.env.<mode>.local`; variables already present in the process take precedence.
All real `.env` variants are ignored by Git.

SQLite databases default to the ignored `.data/` directory. In production on a
persistent server, set `SFC_DATA_DIR` or `SFC_SQLITE_PATH` to a restricted,
encrypted volume. Netlify deployments use their managed Postgres database
instead and do not write SQLite files into the function filesystem.

## Production security

The production server serves the living documentation with CSP, HSTS,
clickjacking protection, referrer and permissions policies, request timeouts,
and connection limits. Mutable realtime demonstration services are disabled by
default; setting `ENABLE_DEMO_SERVICES=true` enables only the public testing
namespaces with same-origin write protection. Terminate TLS at a trusted reverse
proxy. The development server binds to loopback unless `DEV_HOST` is explicitly
configured.

See [SECURITY.md](SECURITY.md) for deployment controls and the one-time Git
history cleanup required for older checkouts.

## Commands

```bash
npm test             # framework, adapters, realtime, and concurrency tests
npm run build        # validate routes and emit dist/public
npm run check        # typecheck, test, build, and enforce performance budgets
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
database/                Portable SQL contract plus SQLite and Netlify drivers
netlify/database/        Netlify Postgres migrations applied during deploys
env-loader.js            Layered local .env loading with process-env precedence
realtime-db.js           Adapter-backed values, versions, subscriptions, and SSE
server.js               Development transform/API server
server.prod.js          Production/preview static and API server
test/                    Unit, integration, security, and load-oriented tests
```
