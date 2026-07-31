import { shopDb } from './shop-db.js';

/**
 * Build-time database route resolver.
 *
 * Route components opt in with `prerender="<source>"`. Keeping this mapping
 * explicit prevents an unrelated `:id` route from accidentally being expanded
 * with IDs from the wrong table.
 */
export function resolveShopPrerenderRoutes(route) {
  switch (route.prerender) {
    case 'products':
      return shopDb.getAllProducts().map(product => ({
        params: { id: product.id },
        data: { product }
      }));

    default:
      return [];
  }
}
