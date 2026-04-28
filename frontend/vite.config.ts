import path from 'path'
import { defineConfig, loadEnv } from 'vite'
import basicSsl from '@vitejs/plugin-basic-ssl'
import react from '@vitejs/plugin-react'

// https://vitejs.dev/config/
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  const backendUrl = env.VITE_API_URL || env.VITE_BACKEND_URL || 'http://127.0.0.1:8799'
  const wsBackendUrl = env.VITE_WS_BACKEND_URL || env.VITE_GROUP_API_URL || 'http://127.0.0.1:8800'
  const useHttps = env.VITE_HTTPS === 'true'
  
  return {
    plugins: [useHttps ? basicSsl() : undefined, react()].filter(Boolean),
    resolve: {
      alias: {
        '@': path.resolve(__dirname, 'src'),
      },
    },
    server: {
      ...(useHttps ? { https: {} } : {}),
      fs: {
        allow: [path.resolve(__dirname, '..')],
      },
      proxy: {
        '/ws': {
          target: wsBackendUrl,
          ws: true,
          changeOrigin: true,
        },
        '/api': {
          target: backendUrl,
          changeOrigin: true,
        },
        '/upload_video': {
          target: backendUrl,
          changeOrigin: true,
        },
        '/report': {
          target: backendUrl,
          changeOrigin: true,
        },
        '/static': {
          target: backendUrl,
          changeOrigin: true,
        },
      },
    },
  }
})
