import { defineConfig } from 'vite';
import sfcPlugin from './src/plugin';

/**
 * Production-optimized dev server configuration
 * 
 * Run with: npm run dev:prod
 * 
 * This mode treats the dev server as a production server with:
 * - Pre-bundling of all dependencies
 * - Aggressive caching
 * - Minification in dev mode
 * - Compression (gzip/brotli)
 * - Native ESM for fastest execution
 */

const isProductionDev = process.env.PROD_DEV === 'true';

export default defineConfig({
  plugins: [
    sfcPlugin({
      // Enable production-like optimizations in dev
      productionMode: isProductionDev,
      // Pre-compile all SFC files on startup
      eagerCompile: isProductionDev,
      // Use persistent disk cache
      persistCache: true
    })
    // Note: vite-plugin-compression can be added for production builds
    // but has limited benefit in dev mode since responses are already optimized
  ],
  
  server: {
    port: 5173,
    // Enable HTTP/2 for multiplexing (requires HTTPS in production)
    // https: true,
    
    // Pre-warm the module graph
    warmup: {
      // Pre-transform these files on server start
      clientFiles: [
        './src/main.ts',
        './src/runtime/index.ts',
        './components/**/*.sfc'
      ]
    },
    
    // Optimize file watching
    watch: {
      // Use native file system events
      usePolling: false,
      // Reduce watcher overhead
      ignored: ['**/node_modules/**', '**/.git/**', '**/.sfc-cache/**', '**/.sfc-debug/**']
    },

    // Enable keep-alive for faster subsequent requests
    headers: {
      'Connection': 'keep-alive',
      'Keep-Alive': 'timeout=5, max=1000'
    }
  },

  // Aggressive dependency pre-bundling
  optimizeDeps: {
    // Pre-bundle ALL known dependencies
    include: [
      '@babel/parser',
      '@babel/traverse',
      '@babel/generator',
      '@babel/types',
      'magic-string',
      'esbuild'
    ],
    // Force pre-bundling even for linked deps
    force: isProductionDev,
    // Use esbuild for fastest transforms
    esbuildOptions: {
      target: 'esnext',
      // Native modules for fastest execution
      format: 'esm',
      // Enable tree shaking
      treeShaking: true
    }
  },

  // ESBuild configuration for fastest transforms
  esbuild: {
    // Target modern browsers only for smallest/fastest output
    target: 'esnext',
    // Minify in production dev mode
    minify: isProductionDev ? 'esbuild' : false,
    // Remove console in production
    drop: isProductionDev ? ['debugger'] : [],
    // Use fastest parsing
    jsx: 'preserve',
    // Inline source maps for debugging
    sourcemap: isProductionDev ? false : 'inline'
  },

  build: {
    // Use esbuild for minification (faster than terser)
    minify: 'esbuild',
    // Target modern browsers
    target: 'esnext',
    // Inline small assets
    assetsInlineLimit: 4096,
    // Faster builds with no sourcemaps in production
    sourcemap: false,
    
    rollupOptions: {
      output: {
        // Manual chunk splitting for optimal caching
        manualChunks: (id) => {
          if (id.includes('/src/runtime/')) return 'runtime';
          if (id.includes('node_modules')) {
            if (id.includes('@babel')) return 'babel';
            return 'vendor';
          }
          // Each component gets its own chunk
          if (id.includes('/components/')) {
            const match = id.match(/\/components\/(.+)\.sfc/);
            if (match) return `route-${match[1].replace(/\//g, '-')}`;
          }
        },
        // Consistent chunk naming for long-term caching
        chunkFileNames: 'assets/[name]-[hash].js',
        entryFileNames: 'assets/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash][extname]'
      }
    }
  },

  // Resolve optimizations
  resolve: {
    // Prefer ES modules
    mainFields: ['module', 'jsnext:main', 'jsnext', 'main'],
    // Cache resolved paths
    dedupe: ['@babel/parser', '@babel/traverse', '@babel/types']
  },

  // CSS optimizations
  css: {
    // Use Lightning CSS for faster CSS processing
    transformer: 'lightningcss',
    lightningcss: {
      targets: {
        chrome: 100,
        firefox: 100,
        safari: 15
      }
    },
    devSourcemap: !isProductionDev
  }
});
