const modules = import.meta.glob('../components/**/*.sfc', { eager: false });
import '../components/GlobalStyles.sfc';
import { routes } from 'virtual:routes';
import { parseRouteParams } from './runtime/index';

const app = document.querySelector('#app') || document.body;

async function navigate(pathname: string) {
  const path = pathname === '/' ? '/' : pathname.replace(/\/$/, '');
  for (const route of routes) {
    if (route.handlerOnly) continue;
    if (route.isRedirect === 'true' && route.path === path && route.redirect) {
      history.replaceState({}, '', route.redirect);
      return navigate(route.redirect);
    }
    const params = parseRouteParams(route.path, path, route.paramNames);
    const matches = route.paramNames.length ? Object.keys(params).length === route.paramNames.length : route.path === path;
    if (!matches || !route.tag) continue;
    await modules[route.filePath]?.();
    app.replaceChildren(document.createElement(route.tag));
    return;
  }
  app.textContent = 'Page not found';
}

document.addEventListener('click', event => {
  const anchor = event.composedPath().find(node => node instanceof HTMLAnchorElement) as HTMLAnchorElement | undefined;
  if (!anchor || anchor.origin !== location.origin) return;
  event.preventDefault();
  history.pushState({}, '', anchor.href);
  navigate(location.pathname);
});
window.addEventListener('popstate', () => navigate(location.pathname));
navigate(location.pathname);
