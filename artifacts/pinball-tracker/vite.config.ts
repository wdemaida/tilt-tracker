import { execSync } from 'node:child_process';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import basicSsl from '@vitejs/plugin-basic-ssl';

// One id per build, baked into the bundle (import.meta.env.VITE_APP_BUILD_ID) and emitted as
// /version.json — an open tab compares the two to notice a newer deploy (src/lib/appVersion.ts).
// Vercel provides the commit SHA; elsewhere ask git; failing both, the build time.
function buildId(): string {
  const sha = process.env.VERCEL_GIT_COMMIT_SHA;
  if (sha) return sha.slice(0, 12);
  try {
    return execSync('git rev-parse --short=12 HEAD', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  } catch {
    return `t${Date.now()}`;
  }
}

const BUILD_ID = buildId();

function versionJson(): Plugin {
  return {
    name: 'tilttrack-version-json',
    apply: 'build',
    generateBundle() {
      this.emitFile({ type: 'asset', fileName: 'version.json', source: JSON.stringify({ buildId: BUILD_ID }) });
    },
  };
}

export default defineConfig({
  plugins: [react(), basicSsl(), versionJson()],
  define: {
    'import.meta.env.VITE_APP_BUILD_ID': JSON.stringify(BUILD_ID),
  },
  server: {
    host: true,
    port: 5174,
    strictPort: true,
    proxy: {
      '/api': { target: 'http://localhost:3001', changeOrigin: true },
    },
  },
});
