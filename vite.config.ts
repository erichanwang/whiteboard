import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

function katexWoff2Only(): Plugin {
  const fallbackSources = /,url\(fonts\/[^)]+\.woff\) format\("woff"\),url\(fonts\/[^)]+\.ttf\) format\("truetype"\)/g;
  return {
    name: "katex-woff2-only",
    enforce: "pre",
    transform(code, id) {
      const normalizedId = id.replaceAll("\\", "/").split("?", 1)[0];
      if (!normalizedId.endsWith("/node_modules/katex/dist/katex.min.css")) return null;
      const transformed = code.replace(fallbackSources, "");
      if (transformed.includes('format("woff")') || transformed.includes('format("truetype")')) {
        this.error("KaTeX CSS contains an unhandled legacy font source.");
      }
      return { code: transformed, map: null };
    },
    generateBundle(_options, bundle) {
      const legacyFont = Object.keys(bundle).find((fileName) => /KaTeX.*\.(?:woff|ttf)$/.test(fileName));
      if (legacyFont) this.error(`Unexpected legacy KaTeX font in build: ${legacyFont}`);
    },
  };
}

// https://vite.dev/config/
export default defineConfig(async () => ({
  plugins: [katexWoff2Only(), react()],

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },
}));
