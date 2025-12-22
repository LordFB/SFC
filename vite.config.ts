import { defineConfig } from 'vite';
import sfcPlugin from './src/plugin';

export default defineConfig({
  plugins: [sfcPlugin()],
  server: {
    port: 5173
  },
  build: {
    rollupOptions: {
      output: {
        manualChunks: (id) => {
          // Split runtime into separate chunk
          if (id.includes('/src/runtime/')) {
            return 'runtime';
          }
          // Split vendor dependencies
          if (id.includes('node_modules')) {
            // Large dependencies get their own chunks
            if (id.includes('@babel')) return 'babel';
            if (id.includes('magic-string')) return 'magic-string';
            return 'vendor';
          }
          // Each component gets its own chunk for route-based splitting
          if (id.includes('/components/')) {
            const match = id.match(/\/components\/(.+)\.sfc/);
            if (match) {
              return `route-${match[1].replace(/\//g, '-')}`;
            }
          }
        }
      }
    },
    // Optimize chunk size
    chunkSizeWarningLimit: 1000,
    // Enable source maps for debugging
    sourcemap: true
  },
  optimizeDeps: {
    // Pre-bundle these for faster dev server startup
    include: ['@babel/parser', '@babel/traverse']
  }
});
