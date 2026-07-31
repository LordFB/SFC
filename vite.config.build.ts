import { defineConfig } from 'vite';
import sfcPlugin from './src/plugin.ts';

/**
 * Build configuration for production.
 * Produces a single-bundle frontend in dist/public/.
 */
export default defineConfig({
  plugins: [sfcPlugin({
    productionMode: true,
    persistCache: false
  })],
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
