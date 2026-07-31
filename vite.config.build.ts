import { defineConfig } from 'vite';
import { fileURLToPath, URL } from 'node:url';
import sfcPlugin from './src/plugin';
import { resolveShopPrerenderRoutes } from './shop-static-routes.js';

/**
 * Build configuration for production.
 * Produces a single-bundle frontend in dist/public/.
 */
export default defineConfig({
  plugins: [sfcPlugin({
    productionMode: true,
    persistCache: false,
    resolvePrerenderRoutes: resolveShopPrerenderRoutes
  })],
  resolve: {
    alias: {
      '@db': fileURLToPath(new URL('./shop-db.js', import.meta.url))
    }
  },
  build: {
    outDir: 'dist/public',
    emptyOutDir: true,
    minify: 'esbuild',
    target: 'esnext',
    sourcemap: false,
    assetsInlineLimit: 4096,
    rollupOptions: {
      output: {
        entryFileNames: 'assets/[name]-[hash].js',
        chunkFileNames: 'assets/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash][extname]'
      }
    }
  },
  css: {
    transformer: 'lightningcss',
    lightningcss: {
      targets: { chrome: 100, firefox: 100, safari: 15 }
    }
  },
  esbuild: {
    target: 'esnext',
    drop: ['debugger'],
    // Keep actionable diagnostics in production, but remove routine framework,
    // router, and component lifecycle noise.
    pure: ['console.log', 'console.debug']
  }
});
