import { defineConfig, loadEnv } from 'vite'

export default defineConfig(({ mode }) => {
  // TYPESAFE_API_KEY comes from .env.local (not committed). It is added to Jev requests
  // here, on the dev server, so the key never reaches the browser (D7, P1).
  const env = loadEnv(mode, process.cwd(), '')

  return {
    base: './',
    build: {
      outDir: 'dist'
    },
    server: {
      proxy: {
        '/api/jev': {
          target: 'https://api.typesafe.ai',
          changeOrigin: true,
          rewrite: () => '/v1/systemone',
          headers: env.TYPESAFE_API_KEY ? { Authorization: `Bearer ${env.TYPESAFE_API_KEY}` } : {},
          // Server-to-server call: drop the browser's Origin so TypeSafe's CORS check never applies.
          configure: (proxy) => {
            proxy.on('proxyReq', (proxyReq) => proxyReq.removeHeader('origin'))
          },
        },
      },
    },
  }
})
