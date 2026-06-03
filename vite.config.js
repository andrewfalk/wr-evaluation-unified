import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

export default defineConfig({
  plugins: [react()],
  base: './',
  resolve: {
    alias: {
      '@contracts': path.resolve('./shared/dist'),
    },
  },
  build: {
    outDir: 'dist/web',
    assetsDir: 'assets',
    sourcemap: false,
    minify: 'esbuild',
    // 인트라넷 클라이언트(윈도7 + 구형 크롬)를 위해 ES2020+ 문법을 트랜스파일.
    // 주의: target은 문법만 변환하므로 Object.hasOwn 같은 신규 "메서드"는
    // 소스에서 직접 호환 코드로 작성해야 함(diagnosisMapping.js 참고).
    target: ['chrome80', 'es2019'],
    rollupOptions: {
      output: {
        manualChunks: {
          vendor: ['react', 'react-dom'],
          xlsx: ['xlsx'],
        },
      },
    },
  },
  server: {
    port: 3000,
    open: true,
    proxy: {
      '/api': {
        target: 'http://localhost:3001',
        changeOrigin: true,
      }
    }
  },
});
