import type { SfcRoute } from 'virtual:routes';
import { isRealtimeValue, type ReactiveRealtimeValue } from './runtime/realtime';

type ActivityItem = {
  kind: 'navigation' | 'error';
  label: string;
  detail: string;
  time: number;
};

const BASIC_ROUTE_KEYS = new Set([
  'path', 'filePath', 'paramNames', 'tag', 'component', 'handlerOnly',
  'isRedirect', 'redirect', 'redirectMethod'
]);

const css = String.raw`
  :host {
    --dt-accent: #c2ec1c;
    --dt-bg: #0c0f0c;
    --dt-panel: #111511;
    --dt-line: #2a3029;
    --dt-muted: #858f84;
    --dt-text: #edf2ea;
    position: fixed;
    left: 16px;
    bottom: 16px;
    z-index: 2147483646;
    color: var(--dt-text);
    font: 12px/1.45 Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    color-scheme: dark;
  }
  * { box-sizing: border-box; }
  button, input { font: inherit; }
  button { color: inherit; }
  .launcher {
    width: 46px;
    height: 46px;
    padding: 5px;
    position: relative;
    display: grid;
    place-items: center;
    border: 1px solid #343b32;
    border-radius: 13px;
    background: rgba(12, 15, 12, .94);
    box-shadow: 0 10px 35px rgba(0, 0, 0, .28), inset 0 1px rgba(255, 255, 255, .06);
    backdrop-filter: blur(14px);
    cursor: pointer;
    transition: border-color .18s, transform .18s, box-shadow .18s;
  }
  .launcher:hover { border-color: #728240; transform: translateY(-2px); box-shadow: 0 14px 40px rgba(0, 0, 0, .36); }
  .launcher:focus-visible, button:focus-visible, input:focus-visible { outline: 2px solid var(--dt-accent); outline-offset: 2px; }
  .launcher img { width: 34px; height: 34px; display: block; object-fit: contain; }
  .route-count {
    min-width: 17px;
    height: 17px;
    padding: 0 4px;
    position: absolute;
    right: -5px;
    top: -5px;
    display: grid;
    place-items: center;
    color: #12160c;
    border: 2px solid var(--dt-bg);
    border-radius: 9px;
    background: var(--dt-accent);
    font: 800 8px/1 ui-monospace, SFMono-Regular, Consolas, monospace;
  }
  .issue-dot {
    width: 9px;
    height: 9px;
    position: absolute;
    left: -2px;
    bottom: -2px;
    display: none;
    border: 2px solid var(--dt-bg);
    border-radius: 50%;
    background: #ff685d;
  }
  :host([data-has-errors]) .issue-dot { display: block; }
  .panel {
    width: min(760px, calc(100vw - 32px));
    height: min(620px, calc(100vh - 84px));
    min-height: 360px;
    display: none;
    overflow: hidden;
    border: 1px solid #343b32;
    border-radius: 14px;
    background: rgba(10, 13, 10, .985);
    box-shadow: 0 30px 100px rgba(0, 0, 0, .62), inset 0 1px rgba(255, 255, 255, .055);
    backdrop-filter: blur(24px);
  }
  :host([open]) .panel { display: grid; grid-template-rows: auto auto 1fr auto; animation: enter .16s ease-out; }
  :host([open]) .launcher { display: none; }
  @keyframes enter { from { opacity: 0; transform: translateY(8px) scale(.985); } }
  .topbar { min-height: 54px; padding: 10px 12px; display: flex; align-items: center; gap: 10px; border-bottom: 1px solid var(--dt-line); }
  .brand { display: flex; align-items: center; gap: 8px; min-width: 112px; }
  .brand img { width: 27px; height: 27px; object-fit: contain; }
  .brand strong { display: block; font-size: 11px; letter-spacing: .4px; }
  .brand small { display: block; color: #71806e; font: 7px/1.2 ui-monospace, monospace; letter-spacing: 1.4px; }
  .tabs { display: flex; align-self: stretch; gap: 3px; }
  .tab { padding: 0 10px; border: 0; border-radius: 7px; background: transparent; color: #778076; cursor: pointer; font-size: 10px; font-weight: 700; }
  .tab[aria-selected="true"] { color: #e8ede5; background: #1b211a; }
  .db-count { min-width: 12px; margin-left: 3px; display: inline-block; color: var(--dt-accent); font: 7px/1 ui-monospace, monospace; }
  .shortcut { margin-left: auto; color: #626b61; font: 8px/1 ui-monospace, monospace; }
  kbd { padding: 3px 5px; color: #8e988b; border: 1px solid #30372f; border-bottom-color: #444d41; border-radius: 4px; background: #151915; font: inherit; }
  .icon-button { width: 30px; height: 30px; display: grid; place-items: center; border: 0; border-radius: 7px; background: transparent; color: #7d867b; cursor: pointer; font-size: 17px; }
  .icon-button:hover { color: #fff; background: #20261f; }
  .metrics { min-height: 38px; padding: 0 14px; display: flex; align-items: center; gap: 17px; overflow-x: auto; border-bottom: 1px solid var(--dt-line); color: #697268; font: 8px/1 ui-monospace, monospace; letter-spacing: .55px; white-space: nowrap; }
  .metrics b { margin-right: 4px; color: #b7c0b3; font-size: 9px; }
  .metrics .live { color: #a9ce22; }
  .metrics .live::before { content: ''; width: 5px; height: 5px; margin-right: 5px; display: inline-block; border-radius: 50%; background: var(--dt-accent); box-shadow: 0 0 8px rgba(194,236,28,.5); }
  .workspace { min-height: 0; display: grid; grid-template-columns: minmax(260px, .88fr) minmax(310px, 1.12fr); }
  .route-browser { min-width: 0; display: grid; grid-template-rows: auto 1fr; border-right: 1px solid var(--dt-line); }
  .search-wrap { padding: 11px; position: relative; border-bottom: 1px solid var(--dt-line); }
  .search-wrap::before { content: '⌕'; position: absolute; left: 22px; top: 18px; color: #778075; font-size: 15px; }
  .search { width: 100%; height: 34px; padding: 0 50px 0 31px; color: #e9eee6; outline: 0; border: 1px solid #30372f; border-radius: 8px; background: #111511; font-size: 10px; }
  .search:focus { border-color: #68773d; box-shadow: 0 0 0 2px rgba(194,236,28,.07); }
  .result-count { position: absolute; right: 22px; top: 21px; color: #5f685e; font: 8px/1 ui-monospace, monospace; }
  .route-list { margin: 0; padding: 6px; overflow: auto; list-style: none; scrollbar-width: thin; scrollbar-color: #353d33 transparent; }
  .route-row { width: 100%; min-height: 48px; padding: 7px 8px; display: grid; grid-template-columns: 7px minmax(0,1fr) auto; align-items: center; gap: 8px; border: 0; border-radius: 7px; background: transparent; text-align: left; cursor: pointer; }
  .route-row:hover { background: #171c17; }
  .route-row.selected { background: #1b2119; box-shadow: inset 0 0 0 1px #303a2d; }
  .route-row.current { background-image: linear-gradient(90deg, rgba(194,236,28,.06), transparent); }
  .route-state { width: 6px; height: 6px; border: 1px solid #566052; border-radius: 50%; }
  .route-row.current .route-state { border-color: var(--dt-accent); background: var(--dt-accent); box-shadow: 0 0 7px rgba(194,236,28,.45); }
  .route-copy { min-width: 0; }
  .route-path { display: block; overflow: hidden; color: #dce2d9; font: 10px/1.35 ui-monospace, SFMono-Regular, Consolas, monospace; text-overflow: ellipsis; white-space: nowrap; }
  .route-component { margin-top: 3px; display: block; overflow: hidden; color: #687167; font-size: 8px; text-overflow: ellipsis; white-space: nowrap; }
  .badges { display: flex; gap: 3px; }
  .badge { padding: 3px 4px; color: #768073; border: 1px solid #30372f; border-radius: 4px; font: 700 6px/1 ui-monospace, monospace; letter-spacing: .4px; }
  .badge.dynamic { color: #b7cd83; border-color: #435033; }
  .badge.redirect { color: #8bc9d7; border-color: #34505a; }
  .inspector { min-width: 0; overflow: auto; }
  .inspector-inner { padding: 19px; }
  .eyebrow { color: #707a6e; font: 8px/1 ui-monospace, monospace; letter-spacing: 1.4px; text-transform: uppercase; }
  .selected-path { margin: 8px 0 5px; overflow-wrap: anywhere; color: #f0f4ed; font: 600 18px/1.2 ui-monospace, SFMono-Regular, Consolas, monospace; letter-spacing: -.6px; }
  .source { color: #6f796d; font: 8px/1.5 ui-monospace, monospace; overflow-wrap: anywhere; }
  .action-row { margin: 15px 0 18px; display: flex; gap: 7px; }
  .action { min-height: 31px; padding: 0 11px; border: 1px solid #343c32; border-radius: 6px; background: #171c16; color: #a9b2a6; cursor: pointer; font-size: 9px; font-weight: 700; }
  .action:hover { color: #eef2eb; border-color: #536047; }
  .action.primary { color: #10140b; border-color: var(--dt-accent); background: var(--dt-accent); }
  .action:disabled { opacity: .4; cursor: default; }
  .param-form { margin: 0 0 17px; padding: 12px; border: 1px solid #2c332b; border-radius: 8px; background: #0e120e; }
  .param-form label { margin-bottom: 8px; display: grid; grid-template-columns: 78px 1fr; align-items: center; gap: 8px; color: #879085; font: 8px/1 ui-monospace, monospace; }
  .param-form label:last-child { margin-bottom: 0; }
  .param-form input { min-width: 0; height: 29px; padding: 0 8px; color: #e5eae2; outline: 0; border: 1px solid #323a31; border-radius: 5px; background: #171b17; font-size: 9px; }
  .section-title { margin: 17px 0 8px; color: #737d71; font: 8px/1 ui-monospace, monospace; letter-spacing: 1.2px; text-transform: uppercase; }
  .facts { display: grid; grid-template-columns: 1fr 1fr; border: 1px solid #293029; border-radius: 8px; overflow: hidden; }
  .fact { min-width: 0; padding: 10px; border-right: 1px solid #293029; border-bottom: 1px solid #293029; }
  .fact:nth-child(even) { border-right: 0; }
  .fact:nth-last-child(-n+2) { border-bottom: 0; }
  .fact span { display: block; color: #626b60; font: 7px/1 ui-monospace, monospace; text-transform: uppercase; letter-spacing: 1px; }
  .fact b { margin-top: 5px; display: block; overflow: hidden; color: #b9c2b6; font: 9px/1.3 ui-monospace, monospace; text-overflow: ellipsis; white-space: nowrap; }
  .metadata { margin: 0; padding: 4px 0; border: 1px solid #293029; border-radius: 8px; background: #0d100d; }
  .meta-row { min-height: 31px; padding: 6px 10px; display: grid; grid-template-columns: minmax(74px,.7fr) 1.3fr; align-items: center; gap: 10px; border-bottom: 1px solid #232923; }
  .meta-row:last-child { border: 0; }
  .meta-row dt { overflow: hidden; color: #71806d; font: 8px/1.3 ui-monospace, monospace; text-overflow: ellipsis; }
  .meta-row dd { margin: 0; overflow-wrap: anywhere; color: #c5cdc2; font: 9px/1.4 ui-monospace, monospace; }
  .empty { padding: 32px 16px; color: #697267; text-align: center; font-size: 10px; }
  .activity-view { min-height: 0; display: none; grid-column: 1 / -1; overflow: auto; }
  :host([data-tab="activity"]) .route-browser, :host([data-tab="activity"]) .inspector,
  :host([data-tab="realtime"]) .route-browser, :host([data-tab="realtime"]) .inspector { display: none; }
  :host([data-tab="activity"]) .activity-view { display: block; }
  .realtime-view { min-height: 0; display: none; grid-column: 1 / -1; grid-template-columns: minmax(260px, .88fr) minmax(310px, 1.12fr); }
  :host([data-tab="realtime"]) .realtime-view { display: grid; }
  .realtime-browser { min-width: 0; display: grid; grid-template-rows: auto 1fr; border-right: 1px solid var(--dt-line); }
  .realtime-head { min-height: 57px; padding: 11px 13px; display: flex; align-items: center; gap: 10px; border-bottom: 1px solid var(--dt-line); }
  .realtime-head div { min-width: 0; }
  .realtime-head b { display: block; color: #cdd5ca; font-size: 10px; }
  .realtime-head span { margin-top: 3px; display: block; overflow: hidden; color: #667064; font-size: 8px; text-overflow: ellipsis; white-space: nowrap; }
  .realtime-head .action { margin-left: auto; flex: 0 0 auto; }
  .value-list { margin: 0; padding: 6px; overflow: auto; list-style: none; }
  .value-row { width: 100%; min-height: 51px; padding: 8px; display: grid; grid-template-columns: 7px minmax(0,1fr) auto; align-items: center; gap: 8px; border: 0; border-radius: 7px; background: transparent; text-align: left; cursor: pointer; }
  .value-row:hover { background: #171c17; }
  .value-row.selected { background: #1b2119; box-shadow: inset 0 0 0 1px #303a2d; }
  .value-state { width: 6px; height: 6px; border-radius: 50%; background: #88b82c; box-shadow: 0 0 7px rgba(194,236,28,.35); }
  .value-copy { min-width: 0; }
  .value-key { display: block; overflow: hidden; color: #dce2d9; font: 10px/1.35 ui-monospace, monospace; text-overflow: ellipsis; white-space: nowrap; }
  .value-preview { margin-top: 3px; display: block; overflow: hidden; color: #687167; font: 8px/1.2 ui-monospace, monospace; text-overflow: ellipsis; white-space: nowrap; }
  .value-version { color: #7d8979; font: 7px/1 ui-monospace, monospace; }
  .realtime-inspector { min-width: 0; overflow: auto; }
  .realtime-inner { padding: 19px; }
  .editor-label { margin: 18px 0 7px; display: flex; align-items: center; justify-content: space-between; color: #737d71; font: 8px/1 ui-monospace, monospace; letter-spacing: 1.2px; text-transform: uppercase; }
  .editor-label span { color: #566054; letter-spacing: 0; text-transform: none; }
  .value-editor { width: 100%; min-height: 132px; padding: 11px; resize: vertical; color: #ced9c9; outline: 0; border: 1px solid #30382f; border-radius: 8px; background: #0c100c; font: 9px/1.55 ui-monospace, SFMono-Regular, Consolas, monospace; tab-size: 2; }
  .value-editor:focus { border-color: #68773d; box-shadow: 0 0 0 2px rgba(194,236,28,.07); }
  .write-status { min-height: 17px; color: #7e897b; font: 8px/1.4 ui-monospace, monospace; }
  .write-status.error { color: #ff8178; }
  .danger { color: #e69a94; border-color: #583c39; }
  .scope-note { margin-top: 17px; padding: 10px 11px; color: #667064; border-left: 2px solid #49543d; background: #101410; font-size: 8px; line-height: 1.55; }
  .activity-head { padding: 16px 18px; display: flex; align-items: center; justify-content: space-between; border-bottom: 1px solid var(--dt-line); }
  .activity-head h2 { margin: 0; font-size: 12px; }
  .activity-list { margin: 0; padding: 7px; list-style: none; }
  .activity-item { padding: 10px 11px; display: grid; grid-template-columns: 55px 1fr auto; gap: 10px; border-bottom: 1px solid #222822; }
  .activity-kind { color: #9cb36d; font: 7px/1.4 ui-monospace, monospace; letter-spacing: .8px; }
  .activity-item.error .activity-kind { color: #ff8178; }
  .activity-copy b { display: block; color: #cfd6cc; font: 9px/1.4 ui-monospace, monospace; }
  .activity-copy span { margin-top: 2px; display: block; color: #6e786c; font-size: 8px; }
  .activity-time { color: #596157; font: 7px/1.4 ui-monospace, monospace; }
  .footer { min-height: 34px; padding: 0 13px; display: flex; align-items: center; gap: 8px; color: #586156; border-top: 1px solid var(--dt-line); font: 7px/1 ui-monospace, monospace; letter-spacing: .6px; }
  .footer .current-label { overflow: hidden; color: #859181; text-overflow: ellipsis; white-space: nowrap; }
  .footer .spacer { margin-left: auto; }
  @media (max-width: 620px) {
    :host { left: 10px; bottom: 10px; }
    .panel { width: calc(100vw - 20px); height: min(690px, calc(100vh - 20px)); }
    .workspace { grid-template-columns: 1fr; grid-template-rows: minmax(190px, .8fr) minmax(220px, 1.2fr); }
    .route-browser { border-right: 0; border-bottom: 1px solid var(--dt-line); }
    .realtime-view { grid-template-columns: 1fr; grid-template-rows: minmax(180px, .75fr) minmax(230px, 1.25fr); }
    .realtime-browser { border-right: 0; border-bottom: 1px solid var(--dt-line); }
    .shortcut { display: none; }
    .brand { min-width: auto; }
    .brand div { display: none; }
  }
  @media (prefers-reduced-motion: reduce) { :host([open]) .panel { animation: none; } }
`;

function routeMatches(route: SfcRoute, query: string): boolean {
  const words = query.toLowerCase().trim().split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const haystack = JSON.stringify(route).toLowerCase();
  return words.every(word => haystack.includes(word));
}

function displayValue(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === undefined) return '—';
  try { return JSON.stringify(value); } catch { return String(value); }
}

function currentRoute(routes: SfcRoute[]): SfcRoute | undefined {
  const path = location.pathname === '/' ? '/' : location.pathname.replace(/\/$/, '');
  return routes.find(route => {
    const pattern = route.path === '/' ? '/' : String(route.path).replace(/\/$/, '');
    const expression = '^' + pattern.split('/').map(part => part.startsWith(':') ? '[^/]+' : part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('/') + '$';
    return new RegExp(expression).test(path);
  });
}

class SfcDevtools extends HTMLElement {
  private routes: SfcRoute[] = [];
  private selected?: SfcRoute;
  private query = '';
  private activity: ActivityItem[] = [];
  private errorCount = 0;
  private startedAt = performance.now();
  private realtimeValues: ReactiveRealtimeValue<unknown>[] = [];
  private selectedRealtime?: ReactiveRealtimeValue<unknown>;
  private realtimeSubscriptions: Array<() => void> = [];
  private realtimeObserver?: MutationObserver;
  private realtimeScanQueued = false;
  private realtimeStatus = new WeakMap<ReactiveRealtimeValue<unknown>, { text: string; error: boolean }>();

  constructor() {
    super();
    this.attachShadow({ mode: 'open' });
  }

  setRoutes(routes: SfcRoute[]) {
    this.routes = routes;
    this.selected = currentRoute(routes) || routes[0];
    this.render();
  }

  connectedCallback() {
    window.addEventListener('keydown', this.onKeydown);
    window.addEventListener('sfc:navigation', this.onNavigation as EventListener);
    window.addEventListener('error', this.onError);
    window.addEventListener('unhandledrejection', this.onRejection);
    this.realtimeObserver = new MutationObserver(() => this.queueRealtimeScan());
    this.realtimeObserver.observe(document.documentElement, { childList: true, subtree: true });
    this.render();
    this.scanRealtimeValues();
  }

  disconnectedCallback() {
    window.removeEventListener('keydown', this.onKeydown);
    window.removeEventListener('sfc:navigation', this.onNavigation as EventListener);
    window.removeEventListener('error', this.onError);
    window.removeEventListener('unhandledrejection', this.onRejection);
    this.realtimeObserver?.disconnect();
    this.realtimeSubscriptions.splice(0).forEach(dispose => dispose());
  }

  private onKeydown = (event: KeyboardEvent) => {
    if (event.altKey && event.key.toLowerCase() === 'd') {
      event.preventDefault();
      this.toggle();
      return;
    }
    if (event.key === 'Escape' && this.hasAttribute('open')) this.close();
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k' && this.hasAttribute('open')) {
      event.preventDefault();
      this.shadowRoot?.querySelector<HTMLInputElement>('.search')?.focus();
    }
  };

  private onNavigation = (event: CustomEvent<{ route?: SfcRoute; path?: string }>) => {
    const route = event.detail?.route || currentRoute(this.routes);
    if (route) this.selected = route;
    this.addActivity('navigation', event.detail?.path || location.pathname, route?.component || route?.tag || 'Route changed');
    this.queueRealtimeScan();
    this.renderContent();
  };

  private onError = (event: ErrorEvent) => {
    this.errorCount++;
    this.toggleAttribute('data-has-errors', true);
    this.addActivity('error', event.message || 'Runtime error', `${event.filename || 'unknown source'}${event.lineno ? `:${event.lineno}` : ''}`);
  };

  private onRejection = (event: PromiseRejectionEvent) => {
    this.errorCount++;
    this.toggleAttribute('data-has-errors', true);
    const message = event.reason instanceof Error ? event.reason.message : String(event.reason);
    this.addActivity('error', 'Unhandled promise rejection', message);
  };

  private addActivity(kind: ActivityItem['kind'], label: string, detail: string) {
    this.activity.unshift({ kind, label, detail, time: Date.now() });
    this.activity = this.activity.slice(0, 40);
    this.renderActivity();
    this.renderMetrics();
  }

  private toggle() {
    if (this.hasAttribute('open')) this.close(); else this.open();
  }

  private open() {
    this.setAttribute('open', '');
    this.renderContent();
    requestAnimationFrame(() => this.shadowRoot?.querySelector<HTMLInputElement>('.search')?.focus());
  }

  private close() { this.removeAttribute('open'); }

  private render() {
    if (!this.shadowRoot) return;
    this.shadowRoot.innerHTML = `
      <style>${css}</style>
      <button class="launcher" type="button" aria-label="Open SFC development tools" title="SFC Devtools · Alt+D">
        <img src="/brand/sfc-mark.svg" alt=""><span class="route-count">${this.routes.length}</span><span class="issue-dot"></span>
      </button>
      <section class="panel" aria-label="SFC development tools">
        <header class="topbar">
          <div class="brand"><img src="/brand/sfc-mark.svg" alt=""><div><strong>SFC Devtools</strong><small>DEVELOPMENT</small></div></div>
          <div class="tabs" role="tablist">
            <button class="tab" type="button" data-tab-target="routes" role="tab" aria-selected="true">Routes</button>
            <button class="tab" type="button" data-tab-target="realtime" role="tab" aria-selected="false">Realtime <span class="db-count"></span></button>
            <button class="tab" type="button" data-tab-target="activity" role="tab" aria-selected="false">Activity</button>
          </div>
          <span class="shortcut"><kbd>Alt</kbd> + <kbd>D</kbd></span>
          <button class="icon-button close" type="button" aria-label="Close devtools">×</button>
        </header>
        <div class="metrics"></div>
        <main class="workspace">
          <section class="route-browser">
            <div class="search-wrap"><input class="search" type="search" placeholder="Filter path, tag, file, metadata…" autocomplete="off"><span class="result-count"></span></div>
            <ul class="route-list"></ul>
          </section>
          <section class="inspector"><div class="inspector-inner"></div></section>
          <section class="activity-view"><div class="activity-head"><h2>Runtime activity</h2><button class="action clear" type="button">Clear</button></div><ol class="activity-list"></ol></section>
          <section class="realtime-view">
            <section class="realtime-browser"><div class="realtime-head"><div><b>Observed values</b><span>Connected component fields</span></div><button class="action scan-values" type="button">Rescan</button></div><ul class="value-list"></ul></section>
            <section class="realtime-inspector"><div class="realtime-inner"></div></section>
          </section>
        </main>
        <footer class="footer"><span class="live">●</span><span>DEV</span><span class="current-label"></span><span class="spacer"></span><span>⌘K search</span></footer>
      </section>`;

    this.shadowRoot.querySelector('.launcher')?.addEventListener('click', () => this.open());
    this.shadowRoot.querySelector('.close')?.addEventListener('click', () => this.close());
    this.shadowRoot.querySelector('.clear')?.addEventListener('click', () => {
      this.activity = [];
      this.errorCount = 0;
      this.removeAttribute('data-has-errors');
      this.renderActivity();
      this.renderMetrics();
    });
    this.shadowRoot.querySelector('.scan-values')?.addEventListener('click', () => this.scanRealtimeValues());
    this.shadowRoot.querySelectorAll<HTMLButtonElement>('[data-tab-target]').forEach(button => button.addEventListener('click', () => {
      const tab = button.dataset.tabTarget || 'routes';
      this.dataset.tab = tab;
      this.shadowRoot?.querySelectorAll<HTMLButtonElement>('[data-tab-target]').forEach(item => item.setAttribute('aria-selected', String(item === button)));
    }));
    this.shadowRoot.querySelector<HTMLInputElement>('.search')?.addEventListener('input', event => {
      this.query = (event.currentTarget as HTMLInputElement).value;
      this.renderRouteList();
    });
    this.renderContent();
  }

  private renderContent() {
    if (!this.shadowRoot) return;
    const current = currentRoute(this.routes);
    const footer = this.shadowRoot.querySelector('.current-label');
    if (footer) footer.textContent = current ? `CURRENT  ${current.path}` : `UNMATCHED  ${location.pathname}`;
    this.renderMetrics();
    this.renderRouteList();
    this.renderInspector();
    this.renderActivity();
    this.renderRealtime();
  }

  private renderMetrics() {
    const target = this.shadowRoot?.querySelector('.metrics');
    if (!target) return;
    const dynamic = this.routes.filter(route => route.paramNames?.length).length;
    const redirects = this.routes.filter(route => route.isRedirect === true || route.isRedirect === 'true').length;
    const handlerOnly = this.routes.filter(route => route.handlerOnly === true || route.handlerOnly === 'true').length;
    const uptime = Math.max(0, Math.round((performance.now() - this.startedAt) / 1000));
    target.replaceChildren();
    for (const [label, value, className] of [
      ['ROUTES', this.routes.length, ''], ['DYNAMIC', dynamic, ''], ['REDIRECTS', redirects, ''],
      ['HANDLERS', handlerOnly, ''], ['REALTIME', this.realtimeValues.length, ''],
      ['ERRORS', this.errorCount, this.errorCount ? 'error' : ''], ['SESSION', `${uptime}s`, 'live']
    ] as Array<[string, string | number, string]>) {
      const item = document.createElement('span');
      item.className = className;
      const strong = document.createElement('b');
      strong.textContent = String(value);
      item.append(strong, label);
      target.append(item);
    }
  }

  private renderRouteList() {
    const list = this.shadowRoot?.querySelector('.route-list');
    const count = this.shadowRoot?.querySelector('.result-count');
    if (!list || !count) return;
    const filtered = this.routes.filter(route => routeMatches(route, this.query));
    count.textContent = `${filtered.length}/${this.routes.length}`;
    list.replaceChildren();
    if (!filtered.length) {
      const empty = document.createElement('li');
      empty.className = 'empty';
      empty.textContent = 'No route matches every search term.';
      list.append(empty);
      return;
    }
    const active = currentRoute(this.routes);
    filtered.forEach(route => {
      const item = document.createElement('li');
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'route-row';
      if (route === this.selected) button.classList.add('selected');
      if (route === active) button.classList.add('current');
      const state = document.createElement('span');
      state.className = 'route-state';
      const copy = document.createElement('span');
      copy.className = 'route-copy';
      const routePath = document.createElement('span');
      routePath.className = 'route-path';
      routePath.textContent = route.path;
      const component = document.createElement('span');
      component.className = 'route-component';
      component.textContent = route.component || route.tag || (route.redirect ? `redirect to ${route.redirect}` : 'server handler');
      copy.append(routePath, component);
      const badges = document.createElement('span');
      badges.className = 'badges';
      if (route.paramNames?.length) badges.append(this.badge('PARAM', 'dynamic'));
      if (route.isRedirect === true || route.isRedirect === 'true') badges.append(this.badge('3XX', 'redirect'));
      if (route.handlerOnly === true || route.handlerOnly === 'true') badges.append(this.badge('API'));
      button.append(state, copy, badges);
      button.addEventListener('click', () => { this.selected = route; this.renderRouteList(); this.renderInspector(); });
      button.addEventListener('dblclick', () => this.navigate(route));
      item.append(button);
      list.append(item);
    });
  }

  private badge(label: string, kind = '') {
    const badge = document.createElement('span');
    badge.className = `badge ${kind}`;
    badge.textContent = label;
    return badge;
  }

  private renderInspector() {
    const root = this.shadowRoot?.querySelector('.inspector-inner');
    if (!root) return;
    root.replaceChildren();
    const route = this.selected;
    if (!route) {
      const empty = document.createElement('div');
      empty.className = 'empty';
      empty.textContent = 'Select a route to inspect its declaration.';
      root.append(empty);
      return;
    }
    const eyebrow = document.createElement('div');
    eyebrow.className = 'eyebrow';
    eyebrow.textContent = route === currentRoute(this.routes) ? '● Current route' : 'Route declaration';
    const title = document.createElement('h2');
    title.className = 'selected-path';
    title.textContent = route.path;
    const source = document.createElement('div');
    source.className = 'source';
    source.textContent = route.filePath || route.component || 'No client component';
    const actions = document.createElement('div');
    actions.className = 'action-row';
    const go = this.action('Navigate', 'primary');
    go.disabled = route.handlerOnly === true || route.handlerOnly === 'true';
    go.addEventListener('click', () => this.navigate(route));
    const copy = this.action('Copy JSON');
    copy.addEventListener('click', async () => {
      await navigator.clipboard.writeText(JSON.stringify(route, null, 2));
      copy.textContent = 'Copied';
      window.setTimeout(() => copy.textContent = 'Copy JSON', 900);
    });
    const log = this.action('Log');
    log.addEventListener('click', () => console.info('[sfc:route]', route));
    actions.append(go, copy, log);
    root.append(eyebrow, title, source, actions);

    if (route.paramNames?.length) {
      const form = document.createElement('div');
      form.className = 'param-form';
      route.paramNames.forEach(name => {
        const label = document.createElement('label');
        label.textContent = name;
        const input = document.createElement('input');
        input.name = name;
        input.placeholder = `:${name}`;
        label.append(input);
        form.append(label);
      });
      root.append(form);
    }

    const factsTitle = document.createElement('h3');
    factsTitle.className = 'section-title';
    factsTitle.textContent = 'Resolved shape';
    const facts = document.createElement('div');
    facts.className = 'facts';
    for (const [label, value] of [
      ['Component', route.tag || '—'], ['Method', route.methods || 'GET'],
      ['Parameters', route.paramNames?.length || 0], ['Layout', route.layout || 'none']
    ]) {
      const fact = document.createElement('div');
      fact.className = 'fact';
      const key = document.createElement('span');
      key.textContent = String(label);
      const output = document.createElement('b');
      output.textContent = String(value);
      fact.append(key, output);
      facts.append(fact);
    }
    root.append(factsTitle, facts);

    const metadataTitle = document.createElement('h3');
    metadataTitle.className = 'section-title';
    metadataTitle.textContent = 'Declaration metadata';
    const metadata = document.createElement('dl');
    metadata.className = 'metadata';
    const entries = Object.entries(route).filter(([key]) => !BASIC_ROUTE_KEYS.has(key));
    if (!entries.length) entries.push(['metadata', 'No additional attributes']);
    entries.forEach(([key, value]) => {
      const row = document.createElement('div');
      row.className = 'meta-row';
      const term = document.createElement('dt');
      term.textContent = key;
      const description = document.createElement('dd');
      description.textContent = displayValue(value);
      row.append(term, description);
      metadata.append(row);
    });
    root.append(metadataTitle, metadata);
  }

  private action(label: string, kind = '') {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `action ${kind}`;
    button.textContent = label;
    return button;
  }

  private navigate(route: SfcRoute) {
    if (route.handlerOnly === true || route.handlerOnly === 'true') return;
    let target = String(route.path);
    for (const name of route.paramNames || []) {
      const input = this.shadowRoot?.querySelector<HTMLInputElement>(`.param-form input[name="${CSS.escape(name)}"]`);
      const value = input?.value.trim();
      if (!value) { input?.focus(); return; }
      target = target.replace(`:${name}`, encodeURIComponent(value));
    }
    const anchor = document.createElement('a');
    anchor.href = target;
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
  }

  private renderActivity() {
    const list = this.shadowRoot?.querySelector('.activity-list');
    if (!list) return;
    list.replaceChildren();
    if (!this.activity.length) {
      const empty = document.createElement('li');
      empty.className = 'empty';
      empty.textContent = 'Navigation and runtime errors will appear here.';
      list.append(empty);
      return;
    }
    this.activity.forEach(entry => {
      const item = document.createElement('li');
      item.className = `activity-item ${entry.kind}`;
      const kind = document.createElement('span');
      kind.className = 'activity-kind';
      kind.textContent = entry.kind.toUpperCase();
      const copy = document.createElement('div');
      copy.className = 'activity-copy';
      const label = document.createElement('b');
      label.textContent = entry.label;
      const detail = document.createElement('span');
      detail.textContent = entry.detail;
      copy.append(label, detail);
      const time = document.createElement('time');
      time.className = 'activity-time';
      time.textContent = new Date(entry.time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
      item.append(kind, copy, time);
      list.append(item);
    });
  }

  private queueRealtimeScan() {
    if (this.realtimeScanQueued) return;
    this.realtimeScanQueued = true;
    queueMicrotask(() => {
      this.realtimeScanQueued = false;
      this.scanRealtimeValues();
    });
  }

  private scanRealtimeValues() {
    const found: ReactiveRealtimeValue<unknown>[] = [];
    const seen = new Set<ReactiveRealtimeValue<unknown>>();
    const visit = (root: Document | ShadowRoot) => {
      for (const element of Array.from(root.querySelectorAll<HTMLElement>('*'))) {
        if (element === this) continue;
        for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(element))) {
          if (!('value' in descriptor) || !isRealtimeValue(descriptor.value) || seen.has(descriptor.value)) continue;
          seen.add(descriptor.value);
          found.push(descriptor.value);
        }
        if (element.shadowRoot) visit(element.shadowRoot);
      }
    };
    visit(document);
    found.sort((a, b) => a.key.localeCompare(b.key));
    const unchanged = found.length === this.realtimeValues.length && found.every((value, index) => value === this.realtimeValues[index]);
    if (unchanged) return;
    this.realtimeSubscriptions.splice(0).forEach(dispose => dispose());
    this.realtimeValues = found;
    if (!this.selectedRealtime || !seen.has(this.selectedRealtime)) this.selectedRealtime = found[0];
    this.realtimeSubscriptions = found.map(value => value.subscribe(() => {
      this.renderRealtime();
      this.renderMetrics();
    }, false));
    this.renderRealtime();
    this.renderMetrics();
  }

  private renderRealtime() {
    const list = this.shadowRoot?.querySelector('.value-list');
    const root = this.shadowRoot?.querySelector('.realtime-inner');
    const count = this.shadowRoot?.querySelector('.db-count');
    if (!list || !root || !count) return;
    count.textContent = this.realtimeValues.length ? String(this.realtimeValues.length) : '';
    const existingEditor = root.querySelector<HTMLTextAreaElement>('.value-editor');
    const draft = existingEditor?.dataset.dirty === 'true' ? existingEditor.value : null;
    list.replaceChildren();
    if (!this.realtimeValues.length) {
      const empty = document.createElement('li');
      empty.className = 'empty';
      empty.textContent = 'No realtime fields are connected on this page.';
      list.append(empty);
    }
    for (const value of this.realtimeValues) {
      const item = document.createElement('li');
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'value-row';
      if (value === this.selectedRealtime) button.classList.add('selected');
      const state = document.createElement('span');
      state.className = 'value-state';
      const copy = document.createElement('span');
      copy.className = 'value-copy';
      const key = document.createElement('span');
      key.className = 'value-key';
      key.textContent = value.key;
      const preview = document.createElement('span');
      preview.className = 'value-preview';
      preview.textContent = this.compactValue(value.value);
      copy.append(key, preview);
      const version = document.createElement('span');
      version.className = 'value-version';
      version.textContent = `v${value.version}`;
      button.append(state, copy, version);
      button.addEventListener('click', () => { this.selectedRealtime = value; this.renderRealtime(); });
      item.append(button);
      list.append(item);
    }
    this.renderRealtimeInspector(root, draft);
  }

  private renderRealtimeInspector(root: Element, draft: string | null) {
    root.replaceChildren();
    const value = this.selectedRealtime;
    if (!value) {
      const empty = document.createElement('div');
      empty.className = 'empty';
      empty.textContent = 'Realtime values declared as component fields will appear here automatically.';
      root.append(empty);
      return;
    }
    const eyebrow = document.createElement('div');
    eyebrow.className = 'eyebrow';
    eyebrow.textContent = '● Live database value';
    const title = document.createElement('h2');
    title.className = 'selected-path';
    title.textContent = value.key;
    const source = document.createElement('div');
    source.className = 'source';
    source.textContent = value.endpoint;
    const factsTitle = document.createElement('h3');
    factsTitle.className = 'section-title';
    factsTitle.textContent = 'Snapshot';
    const facts = document.createElement('div');
    facts.className = 'facts';
    const snapshot = value.snapshot;
    for (const [label, outputValue] of [
      ['Version', value.version], ['Type', this.valueType(value.value)],
      ['Updated', snapshot?.updatedAt ? new Date(snapshot.updatedAt).toLocaleTimeString() : 'local initial'],
      ['Status', snapshot?.deleted ? 'deleted' : snapshot ? 'persisted' : 'awaiting snapshot']
    ]) {
      const fact = document.createElement('div');
      fact.className = 'fact';
      const key = document.createElement('span');
      key.textContent = String(label);
      const output = document.createElement('b');
      output.textContent = String(outputValue);
      fact.append(key, output);
      facts.append(fact);
    }
    const editorLabel = document.createElement('label');
    editorLabel.className = 'editor-label';
    editorLabel.textContent = 'JSON value';
    const revision = document.createElement('span');
    revision.textContent = `compare-and-set v${value.version}`;
    editorLabel.append(revision);
    const editor = document.createElement('textarea');
    editor.className = 'value-editor';
    editor.spellcheck = false;
    editor.value = draft ?? this.prettyValue(value.value);
    if (draft !== null) editor.dataset.dirty = 'true';
    editor.addEventListener('input', () => editor.dataset.dirty = 'true');
    const status = document.createElement('div');
    status.className = 'write-status';
    const savedStatus = this.realtimeStatus.get(value);
    if (savedStatus) {
      status.textContent = savedStatus.text;
      status.classList.toggle('error', savedStatus.error);
    }
    const actions = document.createElement('div');
    actions.className = 'action-row';
    const save = this.action('Write value', 'primary');
    const copy = this.action('Copy JSON');
    const remove = this.action('Delete', 'danger');
    save.addEventListener('click', async () => {
      try {
        const next = JSON.parse(editor.value) as unknown;
        save.disabled = true;
        editor.dataset.dirty = 'false';
        await value.set(next, { expectedVersion: value.version });
        this.realtimeStatus.set(value, { text: `Committed version ${value.version}.`, error: false });
      } catch (error) {
        editor.dataset.dirty = 'true';
        this.realtimeStatus.set(value, { text: error instanceof Error ? error.message : String(error), error: true });
      } finally {
        save.disabled = false;
        this.renderRealtime();
      }
    });
    copy.addEventListener('click', async () => {
      await navigator.clipboard.writeText(editor.value);
      copy.textContent = 'Copied';
      window.setTimeout(() => copy.textContent = 'Copy JSON', 900);
    });
    remove.addEventListener('click', async () => {
      if (!window.confirm(`Delete realtime value "${value.key}"?`)) return;
      try {
        remove.disabled = true;
        await value.delete({ expectedVersion: value.version });
        this.realtimeStatus.set(value, { text: `Deleted at version ${value.version}.`, error: false });
      } catch (error) {
        this.realtimeStatus.set(value, { text: error instanceof Error ? error.message : String(error), error: true });
      } finally {
        remove.disabled = false;
        this.renderRealtime();
      }
    });
    actions.append(save, copy, remove);
    const note = document.createElement('p');
    note.className = 'scope-note';
    note.textContent = 'Scoped inspection: only realtime fields owned by connected components are visible. Reads and writes still pass through the existing server authorization and version checks.';
    root.append(eyebrow, title, source, factsTitle, facts, editorLabel, editor, actions, status, note);
  }

  private valueType(value: unknown): string {
    if (value === null) return 'null';
    if (Array.isArray(value)) return 'array';
    return typeof value;
  }

  private prettyValue(value: unknown): string {
    const output = JSON.stringify(value, null, 2);
    return output === undefined ? 'null' : output;
  }

  private compactValue(value: unknown): string {
    const output = JSON.stringify(value);
    if (output === undefined) return String(value);
    return output.length > 72 ? `${output.slice(0, 69)}...` : output;
  }
}

export function mountDevtools(routes: SfcRoute[]) {
  if (customElements.get('sfc-devtools')) return;
  customElements.define('sfc-devtools', SfcDevtools);
  const devtools = document.createElement('sfc-devtools') as SfcDevtools;
  devtools.setRoutes(routes);
  document.body.append(devtools);
}
