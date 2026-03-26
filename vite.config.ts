import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath, URL } from 'node:url';
import { copyFileSync, mkdirSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const rootDir = fileURLToPath(new URL('.', import.meta.url));
const resolveFromRoot = (relativePath: string): string =>
  fileURLToPath(new URL(relativePath, import.meta.url));

/** 递归复制目录 */
function copyDir(src: string, dest: string): void {
  mkdirSync(dest, { recursive: true });
  for (const entry of readdirSync(src)) {
    const srcPath = join(src, entry);
    const destPath = join(dest, entry);
    if (statSync(srcPath).isDirectory()) {
      copyDir(srcPath, destPath);
    } else {
      copyFileSync(srcPath, destPath);
    }
  }
}

/** Vite 插件：构建完成后将 manifest.json 和 public/ 复制到 dist/ */
function copyExtensionAssets() {
  return {
    name: 'copy-extension-assets',
    closeBundle() {
      // 复制 manifest.json
      copyFileSync('manifest.json', 'dist/manifest.json');
      // 复制 public/icons
      copyDir('public/icons', 'dist/icons');
      // 复制隐私政策页面
      copyFileSync('public/privacy.html', 'dist/privacy.html');
      console.log('[copy-extension-assets] manifest.json, icons & privacy.html copied to dist/');
    },
  };
}

// Chrome Extension Manifest V3 多入口构建配置
export default defineConfig({
  plugins: [react(), copyExtensionAssets()],
  resolve: {
    alias: {
      '@': resolveFromRoot('./src'),
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: true,
    // 禁用 modulePreload polyfill：该 polyfill 使用 window.dispatchEvent，
    // 在 Chrome Extension Service Worker 中会报 ReferenceError: window is not defined
    modulePreload: {
      polyfill: false,
    },
    rollupOptions: {
      input: {
        // Background Service Worker
        background: resolveFromRoot('./src/background/index.ts'),
        // Content Script
        content: resolveFromRoot('./src/content/index.ts'),
        // 注入到页面主上下文的脚本
        'content-injected': resolveFromRoot('./src/content/content-injected.ts'),
        // Options Page
        options: resolveFromRoot('./src/options/index.html'),
        // Side Panel
        sidepanel: resolveFromRoot('./src/sidepanel/index.html'),
        // Popup Page (legacy, kept for fallback)
        popup: resolveFromRoot('./src/popup/index.html'),
      },
      output: {
        entryFileNames: (chunkInfo) => {
          if (chunkInfo.name === 'background') {
            return 'background.js';
          }
          if (chunkInfo.name === 'content') {
            return 'content.js';
          }
          if (chunkInfo.name === 'content-injected') {
            return 'content-injected.js';
          }
          return 'assets/[name]-[hash].js';
        },
        chunkFileNames: 'assets/[name]-[hash].js',
        assetFileNames: (assetInfo) => {
          const info = assetInfo.name || '';
          if (info.endsWith('.css')) {
            return 'assets/[name]-[hash][extname]';
          }
          return 'assets/[name][extname]';
        },
      },
    },
  },
  // 开发服务器配置
  server: {
    port: 3000,
    strictPort: true,
    hmr: {
      port: 3001,
    },
  },
});
