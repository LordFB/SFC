---
name: sfc-skill
description: Build, extend, debug, and review components, routes, runtime behavior, server APIs, and production output in this repository's custom .sfc framework. Use when Codex works on files under components/, SFC template/script/style/route blocks, custom-element lifecycle behavior, route prerendering, shop UI or API integration, CSS isolation, the SFC transformer/plugin/runtime, or related tests and builds.
---

# SFC Project Workflow

Read [references/sfc-project.md](references/sfc-project.md) before editing this project. It is the source of truth for the local SFC dialect and runtime behavior.

## Work from repository truth

1. Inspect the target component, a neighboring component with similar behavior, and the relevant transformer/runtime/server path.
2. Preserve unrelated work in the dirty tree.
3. Identify whether the change belongs to a component, global style, route declaration, runtime/compiler, or server authorization boundary.
4. Follow existing architecture unless the task explicitly changes it.

## Build components safely

- Keep the component tag unique and declare it with `static tag`.
- Treat ordinary `<style>` blocks as persistent document CSS for light-DOM components. Prefix every selector with the component host tag.
- Use `<style global>` only for deliberate application-wide rules.
- Use `static shadow = true` when actual Shadow DOM isolation is required; query `this.shadowRoot` in that case.
- Attach global/window listeners once and remove them in `disconnectedCallback`.
- Render untrusted data with `textContent`. Escape values before inserting them into `innerHTML`.
- Use `window.shopAuth.api` for shop API calls. Never create client-controlled session identifiers or authorization state.

## Handle routes and data

- Add one `<route>` declaration per routable component.
- Give every dynamic production route either a recognized `prerender` source or `prerender="skip"`.
- Keep private/customer data out of route blobs and prerender resolvers.
- Treat client redirects as UX only; enforce authentication and ownership on the server.

## Validate

Run the bundled audit against each changed SFC:

```powershell
powershell -ExecutionPolicy Bypass -File .agents/skills/sfc-skill/scripts/audit-sfc.ps1 -Path components/shop/Account.sfc
```

Then run the narrowest relevant checks, followed by:

```powershell
npm.cmd test
npm.cmd run build
```

Report any pre-existing failures separately from changes introduced by the task.
