// lazy-import components on-demand for route-based code splitting
const modules = import.meta.glob('../components/**/*.sfc', { eager: false });

// Eagerly load global styles so shared appearance is applied immediately
import '../components/GlobalStyles.sfc';

import { routes } from 'virtual:routes';
import { parseRouteParams } from './runtime/index';

console.log('App started, routes:', routes);

// Component loading cache to track which modules have been loaded
const loadedModules = new Map<string, boolean>();

// Current active component element
let currentRouteElement: HTMLElement | null = null;

// Preload cache for hover intent
const preloadCache = new Set<string>();

localStorage.setItem('sfc-disable-transitions', 'false');

// SPA Router with navigation events
async function navigateToRoute(fullPath: string, pushState = true) {
  console.log('[router] navigating to:', fullPath);
  
  // Split path and query string
  const [pathPart, queryPart] = fullPath.split('?');
  const search = queryPart ? '?' + queryPart : '';
  
  // normalize trailing slash: treat '/foo/' and '/foo' as the same
  const normalize = (p: string) => { if (!p) return '/'; return p === '/' ? '/' : p.replace(/\/$/, '').replace(/\/$/, ''); };
  const path = normalize(pathPart);
  // Add loading indicator
  //document.body.classList.add('loading');
  
  try {
    // Find matching route (match against pathname only, not query string)
    let matchedRoute = null;
    for (const route of routes) {
      if (route.handlerOnly) continue;
      const routePathNorm = route.path === '/' ? '/' : String(route.path).replace(/\/$/, '');
      const routeParams = parseRouteParams(routePathNorm, path, route.paramNames);
      if (route.paramNames.length > 0 ? Object.keys(routeParams).length === route.paramNames.length : routePathNorm === path) {
        matchedRoute = route;
        break;
      }
    }

    if (!matchedRoute) {
      console.warn('[router] No route matched for path:', path);
      // Navigate to 404 page
      navigateToRoute('/404', pushState);
      return;
    }

    // Handle redirect route
    if (matchedRoute.isRedirect === 'true' && matchedRoute.redirect) {
      const target = matchedRoute.redirect;
      const method = matchedRoute.redirectMethod || '302';
      // For 301, use replaceState; for 302, use pushState by default
      if (method === '301') {
        window.history.replaceState({ path: target }, '', target);
      } else {
        window.history.pushState({ path: target }, '', target);
      }
      // Trigger navigation to the redirect target
      navigateToRoute(target, false);
      return;
    }

    // Lazy-load component module if not already loaded
    const moduleKey = matchedRoute.filePath;
    if (!loadedModules.has(moduleKey)) {
      console.log('[router] Loading component:', moduleKey);
      try {
        await modules[moduleKey]();
        loadedModules.set(moduleKey, true);
      } catch (e) {
        console.error('[router] Failed to load component:', moduleKey, e);
        return;
      }
    }

    // Update browser history BEFORE creating component so window.location is correct when connectedCallback runs
    if (pushState) {
      const fullUrl = path + search;
      window.history.pushState({ path: fullUrl }, '', fullUrl);
    }

    // Use View Transition API if available
    const performTransition = () => {
      if (!matchedRoute.tag) {
        console.error('[router] matched route has no tag:', matchedRoute);
        return;
      }
      // Remove old element first to prevent flash from double-rendering
      const previous = currentRouteElement;
      if (previous) {
        try { previous.remove(); } catch (e) { console.warn(e); }
      }
      // Then create and mount new component
      const el = document.createElement(matchedRoute.tag);
      document.body.appendChild(el);
      currentRouteElement = el;
    };

    // Check if transitions are disabled via localStorage or prefers-reduced-motion
    const transitionsDisabled = localStorage.getItem('sfc-disable-transitions') === 'true' 
      || window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    if ((document as any).startViewTransition && !transitionsDisabled) {
      try {
        await (document as any).startViewTransition(performTransition).finished;
      } catch (e) {
        // Fallback if transition fails
        performTransition();
      }
    } else {
      performTransition();
    }
  } finally {
    // Remove loading indicator
    document.body.classList.remove('loading');
  }
}

// Preload route component on hover/intersection
async function preloadRoute(path: string) {
  if (preloadCache.has(path)) return;
  preloadCache.add(path);
  const normalize = (p: string) => { if (!p) return '/'; return p === '/' ? '/' : p.replace(/\/$/, ''); };
  path = normalize(path);
  for (const route of routes) {
    if (route.handlerOnly) continue;
    const routePathNorm = route.path === '/' ? '/' : String(route.path).replace(/\/$/, '');
    const routeParams = parseRouteParams(routePathNorm, path, route.paramNames);
    if (route.paramNames.length > 0 ? Object.keys(routeParams).length === route.paramNames.length : routePathNorm === path) {
      const moduleKey = route.filePath;
      if (!loadedModules.has(moduleKey)) {
        console.log('[router] Preloading component:', moduleKey);
        try {
          await modules[moduleKey]();
          loadedModules.set(moduleKey, true);
        } catch (e) {
          console.error('[router] Failed to preload:', moduleKey, e);
        }
      }
      break;
    }
  }
}

// Intercept link clicks for SPA navigation
document.addEventListener('click', (e) => {
  const target = (e.target as HTMLElement).closest('a[href]');
  if (!target) return;
  
  const href = target.getAttribute('href');
  if (!href || href.startsWith('http') || href.startsWith('//') || href.startsWith('#')) return;
  
  e.preventDefault();
  // Compare full URL (pathname + search) to handle query string changes
  const currentUrl = window.location.pathname + window.location.search;
  if (href !== currentUrl) {
    navigateToRoute(href, true);
  }
});

// Handle browser back/forward buttons
window.addEventListener('popstate', (e) => {
  const raw = e.state?.path || (window.location.pathname + window.location.search);
  const pathNorm = raw === '/' ? '/' : String(raw).replace(/\/$/, '');
  navigateToRoute(pathNorm, false);
});

// Preload on link hover (predictive loading)
let hoverTimer: number | null = null;
document.addEventListener('mouseover', (e) => {
  const target = (e.target as HTMLElement).closest('a[href]');
  if (!target) return;
  
  const href = target.getAttribute('href');
  if (!href || href.startsWith('http') || href.startsWith('//') || href.startsWith('#')) return;
  
  if (hoverTimer) clearTimeout(hoverTimer);
  hoverTimer = window.setTimeout(() => {
    preloadRoute(href);
  }, 50);
});

// Initial route on page load
const initialPath = window.location.pathname === '/' ? '/' : String(window.location.pathname).replace(/\/$/, '');
navigateToRoute(initialPath, false);

// HMR: listen for sfc:update events from the plugin and apply them via runtime
if (import.meta.hot) {
	import.meta.hot.on && import.meta.hot.on('sfc:update', async (payload: any) => {
		try {
			const apply = (await import('/src/runtime/index')).defineComponent.__sfc_applyUpdate;
			if (apply) apply(payload.file, { template: payload.template, css: payload.css });
		} catch (e) {
			// fallback: try global
			try {
				const rc = (window as any).defineComponent as any;
				if (rc && rc.__sfc_applyUpdate) rc.__sfc_applyUpdate(payload.file, { template: payload.template, css: payload.css });
			} catch (ee) {}
		}
	});
}
