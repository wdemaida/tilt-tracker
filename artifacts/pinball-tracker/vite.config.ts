import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import basicSsl from '@vitejs/plugin-basic-ssl';

export default defineConfig({
  plugins: [react(), basicSsl()],
  server: {
    host: true,
    port: 5174,
    strictPort: true,
    https: true,
    proxy: {
      '/api': { target: 'http://localhost:3000', changeOrigin: true },
    },
  },
});
