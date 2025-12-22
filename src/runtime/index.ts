// Template fragment cache for performance
const templateCache = new Map<string, DocumentFragment>();

function getTemplateFragment(html: string): DocumentFragment {
  let frag = templateCache.get(html);
  if (!frag) {
    const template = document.createElement('template');
    template.innerHTML = html;
    frag = template.content;
    templateCache.set(html, frag);
  }
  return frag.cloneNode(true) as DocumentFragment;
}

export type ComponentOptions = {
  tag?: string;
  template?: string;
  shadow?: boolean;
  observedAttributes?: string[];
  connectedCallback?: () => void;
  disconnectedCallback?: (name: string, oldV: any, newV: any) => void;
  attributeChangedCallback?: (name: string, oldV: any, newV: any) => void;
  postHandler?: (body: any, req: any, res: any) => void;
};

export function parseRouteParams(pathPattern: string, currentPath: string, paramNames: string[]): Record<string, string> {
  const params: Record<string, string> = {};
  const regexPattern = pathPattern.replace(/:([a-zA-Z_][a-zA-Z0-9_]*)/g, '([^/]+)');
  const regex = new RegExp('^' + regexPattern + '$');
  const match = currentPath.match(regex);
  if (match) {
    paramNames.forEach((name, i) => {
      params[name] = match[i + 1];
    });
  }
  return params;
}

export function parseQueryParams(search: string): Record<string, string> {
  const params: Record<string, string> = {};
  const urlParams = new URLSearchParams(search);
  for (const [key, value] of urlParams) {
    params[key] = value;
  }
  return params;
}

export function interpolateTemplate(root: Element | ShadowRoot, params: Record<string, any>) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
  let node: Text | null;
  while ((node = walker.nextNode() as Text)) {
    let text = node.textContent || '';
    if (text.includes('{{')) {
      for (const [key, value] of Object.entries(params)) {
        text = text.replace(new RegExp(`\\{\\{\\s*${key}\\s*\\}\\}`, 'g'), String(value));
      }
      node.textContent = text;
    }
  }
}

// Track which styles have been attached to which elements
const attachedStylesMap = new WeakMap<Element | ShadowRoot, Set<string>>();

export function attachStyles(root: ShadowRoot | Element, css: string) {
  if (!css) return;
  // debug flag: set to true during local debugging to get console traces
  const DEBUG_ATTACH = false;
  
  // Check if already attached to this root
  let attachedStyles = attachedStylesMap.get(root);
  if (!attachedStyles) {
    attachedStyles = new Set<string>();
    attachedStylesMap.set(root, attachedStyles);
  }
  
  // Simple hash for deduplication
  let hash = 5381;
  for (let i = 0; i < css.length; i++) hash = ((hash << 5) + hash) + css.charCodeAt(i);
  const key = String(hash >>> 0);
  
  if (attachedStyles.has(key)) {
    // Already attached to this root, skip
    return;
  }
  attachedStyles.add(key);
  
  try {
    // prefer adoptedStyleSheets when available and cache constructed sheets
    // host: if root is ShadowRoot we attach to that, otherwise use document (and document.head for <style> fallback)
    const host = (root instanceof ShadowRoot) ? root : document;
    const supportsAdopted = typeof (host as any).adoptedStyleSheets !== 'undefined';
    if (supportsAdopted) {
      const cache = (attachStyles as any)._sheetCache || ((attachStyles as any)._sheetCache = new Map<string, CSSStyleSheet>());
      let sheet = cache.get(key);
      if (!sheet) {
        sheet = new CSSStyleSheet();
        try { sheet.replaceSync(css); } catch (e) { try { sheet.replace(css); } catch (e2) {} }
        cache.set(key, sheet);
      }
      // Create a new array to avoid mutating existing adoptedStyleSheets in-place
      try {
        const existing = (host as any).adoptedStyleSheets || [];
        // avoid duplicate sheets
        if (!existing.includes(sheet)) {
          (host as any).adoptedStyleSheets = [...existing, sheet];
          if (DEBUG_ATTACH) console.debug('[sfc] attachStyles: adoptedStyleSheets assigned', { host, key });
        } else {
          if (DEBUG_ATTACH) console.debug('[sfc] attachStyles: sheet already present', { host, key });
        }
        return;
      } catch (e) {
        if (DEBUG_ATTACH) console.warn('[sfc] attachStyles: adoptedStyleSheets assignment failed', e);
        // if assignment fails, fall back to <style>
      }
    }
  } catch (e) {
    // fallback to style tag below
  }
  const style = document.createElement('style');
  style.textContent = css;
  const target = (root instanceof ShadowRoot) ? root : document.head;
  target.appendChild(style);
  if ((attachStyles as any)._debug || DEBUG_ATTACH) console.debug('[sfc] attachStyles: appended <style> to', target, 'key=', key);
}

export function defineComponent(optsOrCtor: any) {
  // runtime hook: apply updates for HMR
  (defineComponent as any).__sfc_applyUpdate = function(sourceId: string, payload: { template?: string, css?: string }) {
    try {
      // find all instances whose constructor.__sfc_source === sourceId
      const all = Array.from(document.querySelectorAll('*')) as HTMLElement[];
      for (const el of all) {
        try {
          const ctor = (el as any).constructor as any;
          if (!ctor) continue;
          if (ctor.__sfc_source === sourceId || (el as any).__sfc_source === sourceId) {
            // update template
            if (payload.template) {
              try {
                const mountRoot = (el.shadowRoot || el) as any;
                mountRoot.innerHTML = payload.template;
              } catch (e) {}
            }
            // update styles
            if (payload.css) {
              try { attachStyles((el.shadowRoot || document) as any, payload.css); } catch (e) {}
            }
            // re-run decorator wiring if available
            try {
              if ((el as any).connectedCallback) {
                try { (el as any).connectedCallback(); } catch (e) {}
              }
            } catch (e) {}
          }
        } catch (e) {}
      }
    } catch (e) {}
  };
  // if a class/constructor is provided, register it directly
  if (typeof optsOrCtor === 'function') {
    const ctor = optsOrCtor as CustomElementConstructor;
    const tag = (ctor as any).tag || (ctor as any).tagName || (ctor as any).observedTag || ((ctor as any).prototype && ((ctor as any).prototype.tag || (ctor as any).prototype.tagName)) || null;
    if (!tag) throw new Error('When passing a constructor, set static tag or tagName on it');
    if (!customElements.get(tag)) {
      // wrap the constructor to wire decorators without modifying the original class
      const Wrapped = class extends (ctor as any) {
        __sfc_listeners: any[] = [];
        __attrObserver: MutationObserver | null = null;
        shadow: ShadowRoot | null = null;
        constructor(...a: any[]) {
          super(...a);
          // if the original constructor set a static shadow flag, create a shadow root
          try {
            const s = (this.constructor as any).shadow || (this.constructor as any).staticShadow;
            if (s && !this.shadowRoot) {
              try { this.shadow = this.attachShadow({ mode: 'open' }); } catch (e) { this.shadow = (this as any).shadowRoot || null; }
            }
          } catch (e) {}
        }
        connectedCallback() {
          // call original
          try { if (super.connectedCallback) super.connectedCallback(); } catch (e) { console.error(e); }
          // mountRoot: prefer a created shadow (this.shadow), then native shadowRoot, then the element itself
          const mountRoot: Element | ShadowRoot = (this as any).shadow || (this as any).shadowRoot || (this as any);
          // inject template if available using cached fragments
          if ((this.constructor as any).__sfc_template) {
            const frag = getTemplateFragment((this.constructor as any).__sfc_template);
            mountRoot.appendChild(frag);
          }
          // attach styles using the same mountRoot so styles scope to shadow when present
          ((this.constructor as any).__sfc_attach || (() => {}))(mountRoot);
          // defer wiring to next microtask so subclass connectedCallback can finish DOM changes
          try {
            Promise.resolve().then(()=>{
              try {
                // Check if decorator wiring has been cached on constructor
                const cachedWiring = (this.constructor as any).__sfc_wiring_cache;
                if (cachedWiring) {
                  // Use cached wiring metadata
                  for (const wire of cachedWiring) {
                    try {
                      if (wire.eventType) {
                        const fn = (this as any)[wire.methodName];
                        const handler = fn.bind(this);
                        if (wire.selector) {
                          const nodes = Array.from((mountRoot as Element).querySelectorAll(wire.selector));
                          if (nodes.length) {
                            console.debug('[sfc] wiring cached decorator', { tag, method: wire.methodName, type: wire.eventType, selector: wire.selector, count: nodes.length });
                            for (const node of nodes) {
                              const wrappedHandler = function(e: any) { try { console.debug('[sfc] decorator invoked', { tag, method: wire.methodName }); } catch {} ; return handler(e); };
                              node.addEventListener(wire.eventType, wrappedHandler);
                              (this as any).__sfc_listeners.push({ el: node, type: wire.eventType, handler: wrappedHandler });
                            }
                          }
                        } else {
                          const wrappedHandler = function(e: any) { try { console.debug('[sfc] decorator invoked', { tag, method: wire.methodName }); } catch {} ; return handler(e); };
                          (this as any).addEventListener(wire.eventType, wrappedHandler);
                          (this as any).__sfc_listeners.push({ el: this, type: wire.eventType, handler: wrappedHandler });
                        }
                      } else if (wire.transformType) {
                        const fn = (this as any)[wire.methodName];
                        const original = fn.bind(this);
                        let wrapped: any;
                        if (wire.transformType === 'debounce') {
                          let t: any = null;
                          wrapped = function(...a: any[]) { if (t) clearTimeout(t); t = setTimeout(()=> { try { console.debug('[sfc] decorator invoked (debounce)', { tag, method: wire.methodName }); } catch {} ; original(...a); }, wire.delay); };
                        } else {
                          let last = 0;
                          wrapped = function(...a: any[]) { const now = Date.now(); if (now - last > wire.delay) { last = now; try { console.debug('[sfc] decorator invoked (throttle)', { tag, method: wire.methodName }); } catch {} ; original(...a); } };
                        }
                        Object.defineProperty(this, wire.methodName, { value: wrapped });
                      }
                    } catch (e) {}
                  }
                } else {
                  // First time - traverse prototype and cache wiring metadata
                  const wiringCache: any[] = [];
                  let proto: any = Object.getPrototypeOf(this);
                  while (proto && proto !== HTMLElement.prototype) {
                    for (const key of Object.getOwnPropertyNames(proto)) {
                      try {
                        const desc = Object.getOwnPropertyDescriptor(proto, key);
                        if (!desc) continue;
                        const fn = (this as any)[key];
                        if (!fn) continue;
                        const decs = fn.__sfc_decorators || (desc.value && desc.value.__sfc_decorators);
                        if (!decs || !Array.isArray(decs)) continue;
                        for (const meta of decs) {
                          const type = (meta.type || '').replace(/^on/, '');
                          const args = meta.args || [];
                          if (type === 'click' || type === 'input' || type === 'change') {
                            const selector = args[0] || null;
                            wiringCache.push({ methodName: key, eventType: type, selector });
                            const handler = fn.bind(this);
                            if (selector) {
                              const nodes = Array.from((mountRoot as Element).querySelectorAll(selector));
                              if (nodes.length) {
                                console.debug('[sfc] wiring decorator', { tag: tag, method: key, type, selector: selector, count: nodes.length });
                                for (const node of nodes) {
                                  const wrappedHandler = function(e: any) { try { console.debug('[sfc] decorator invoked', { tag, method: key }); } catch {} ; return handler(e); };
                                  node.addEventListener(type, wrappedHandler);
                                  (this as any).__sfc_listeners.push({ el: node, type, handler: wrappedHandler });
                                }
                              } else {
                                console.debug('[sfc] decorator selector not found', { tag: tag, method: key, type, selector: selector });
                              }
                            } else {
                              const wrappedHandler = function(e: any) { try { console.debug('[sfc] decorator invoked', { tag, method: key }); } catch {} ; return handler(e); };
                              (this as any).addEventListener(type, wrappedHandler);
                              (this as any).__sfc_listeners.push({ el: this, type, handler: wrappedHandler });
                            }
                          } else if (type === 'debounce' || type === 'throttle') {
                            const delay = Number(args[0]) || 200;
                            wiringCache.push({ methodName: key, transformType: type, delay });
                            const original = fn.bind(this);
                            let wrapped: any;
                            if (type === 'debounce') {
                              let t: any = null;
                              wrapped = function(...a: any[]) { if (t) clearTimeout(t); t = setTimeout(()=> { try { console.debug('[sfc] decorator invoked (debounce)', { tag, method: key }); } catch {} ; original(...a); }, delay); };
                            } else {
                              let last = 0;
                              wrapped = function(...a: any[]) { const now = Date.now(); if (now - last > delay) { last = now; try { console.debug('[sfc] decorator invoked (throttle)', { tag, method: key }); } catch {} ; original(...a); } };
                            }
                            Object.defineProperty(this, key, { value: wrapped });
                          }
                        }
                      } catch (e) {
                        // ignore per-method errors
                      }
                    }
                    proto = Object.getPrototypeOf(proto);
                  }
                  // Cache wiring metadata on constructor for future instances
                  (this.constructor as any).__sfc_wiring_cache = wiringCache;
                }
                // parse route params
                const route = (this.constructor as any).__route;
                if (route) {
                  const routeParams = parseRouteParams(route.path, window.location.pathname, route.paramNames || []);
                  const queryParams = parseQueryParams(window.location.search);
                  (this as any).routeParams = routeParams;
                  (this as any).queryParams = queryParams;
                  (this as any).params = { ...routeParams, ...queryParams };
                }
                // interpolate template
                interpolateTemplate(mountRoot, (this as any).params || {});
              } catch (e) { console.error(e); }
            });
          } catch (e) { console.error(e); }
        }
        disconnectedCallback() {
          try {
            const list = (this as any).__sfc_listeners || [];
            for (const it of list) {
              try { it.el.removeEventListener(it.type, it.handler); } catch (e) {}
            }
            (this as any).__sfc_listeners = [];
          } catch (e) {}
          try { if (super.disconnectedCallback) super.disconnectedCallback(); } catch (e) { console.error(e); }
        }
      };

      customElements.define(tag, Wrapped as any);
      console.debug('[sfc] defined custom element from constructor', tag);
    }
    return ctor;
  }

  const opts: ComponentOptions & Record<string, any> = optsOrCtor || {};
  const tag = opts.tag || (opts.template ? 'sfc-component' : 'sfc-unknown');

  const protoMethods: Record<string, Function> = {};
  // copy non-lifecycle methods onto prototype later
  for (const k of Object.keys(opts)) {
    if (['tag', 'template', 'shadow', 'observedAttributes', 'connectedCallback', 'disconnectedCallback', 'attributeChangedCallback', '_attach'].indexOf(k) === -1) {
      const v = opts[k];
      if (typeof v === 'function') protoMethods[k] = v;
    }
  }

  class SFCElement extends HTMLElement {
    static get observedAttributes() { return opts.observedAttributes || (opts.observedAttributes === undefined && Array.isArray(opts.observedAttributes) ? opts.observedAttributes : opts.observedAttributes || []); }
    shadow: ShadowRoot | null = null;
    __attrObserver: MutationObserver | null = null;
    constructor() {
      super();
      if (opts.shadow) {
        this.shadow = this.attachShadow({ mode: 'open' });
      }
    }
    connectedCallback() {
      console.debug('[sfc] connected:', tag, this);
      const mountRoot: Element | ShadowRoot = this.shadow || this;
      if (opts.template) {
        const frag = getTemplateFragment(opts.template as string);
        mountRoot.appendChild(frag);
      }
      (opts as any)._attach(mountRoot);
      // parse route params
      const route = opts.__route;
      if (route) {
        const routeParams = parseRouteParams(route.path, window.location.pathname, route.paramNames || []);
        const queryParams = parseQueryParams(window.location.search);
        (this as any).routeParams = routeParams;
        (this as any).queryParams = queryParams;
        (this as any).params = { ...routeParams, ...queryParams };
      }
      // interpolate template
      interpolateTemplate(mountRoot, (this as any).params || {});
      // call user connectedCallback
      if (opts.connectedCallback) {
        try { opts.connectedCallback.call(this); } catch (e) { console.error(e); }
      }
      // if attributeChangedCallback is provided but observedAttributes is not,
      // set up a MutationObserver fallback to notify attribute changes
      if (typeof opts.attributeChangedCallback === 'function' && (!opts.observedAttributes || opts.observedAttributes.length === 0)) {
        try {
          this.__attrObserver = new MutationObserver((mutations) => {
            for (const m of mutations) {
              if (m.type === 'attributes' && m.attributeName) {
                const oldV = (m as MutationRecord).oldValue;
                const newV = this.getAttribute(m.attributeName!);
                try { opts.attributeChangedCallback.call(this, m.attributeName, oldV, newV); } catch (e) { console.error(e); }
              }
            }
          });
          this.__attrObserver.observe(this, { attributes: true, attributeOldValue: true });
        } catch (e) {
          // ignore
          // holder for decorator-generated listeners so we can disconnect later
          (this as any).__sfc_listeners = [];
        }
      }
      if (typeof opts.connectedCallback === 'function') opts.connectedCallback.call(this);
    }
    disconnectedCallback() {
      if (opts.disconnectedCallback) {
        try { opts.disconnectedCallback.call(this); } catch (e) { console.error(e); }
      }
      if (this.__attrObserver) {
        try { this.__attrObserver.disconnect(); } catch (e) {}
        this.__attrObserver = null;
      }
      // remove listeners wired by decorators
      try {
        const list = (this as any).__sfc_listeners || [];
        for (const it of list) {
          try { it.el.removeEventListener(it.type, it.handler); } catch (e) {}
        }
        (this as any).__sfc_listeners = [];
      } catch (e) {}
    }
    attributeChangedCallback(name: string, oldV: any, newV: any) {
      if (typeof opts.attributeChangedCallback === 'function') opts.attributeChangedCallback.call(this, name, oldV, newV);
    }
  }

  // attach protoMethods to prototype so instances get them
  for (const k of Object.keys(protoMethods)) {
    Object.defineProperty((SFCElement as any).prototype, k, { value: protoMethods[k], writable: true });
  }

  try {
    if (!customElements.get(tag)) {
      customElements.define(tag, SFCElement);
      console.debug('[sfc] defined custom element', tag);
    } else {
      console.debug('[sfc] custom element already defined', tag);
    }
  } catch (e) {
    console.warn('defineComponent: failed to define', tag, e);
  }

  return SFCElement;
}
