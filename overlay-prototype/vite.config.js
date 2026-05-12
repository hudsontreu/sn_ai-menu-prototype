import { defineConfig } from 'vite';
import { qaPlugin } from './scripts/qa-plugin.js';

export default defineConfig({
  plugins: [qaPlugin()],
  server: {
    port: 5173,
    open: true,
  },
});
