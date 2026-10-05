import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

function inlineMcpAppBundle(): Plugin {
  return {
    name: "inline-mcp-app-bundle",
    enforce: "post",
    generateBundle(_options, bundle) {
      const htmlAsset = Object.values(bundle).find((item) => item.type === "asset" && item.fileName.endsWith(".html"));
      if (!htmlAsset || htmlAsset.type !== "asset") throw new Error("Vite did not emit an HTML entry");
      let html = String(htmlAsset.source);
      for (const [fileName, item] of Object.entries(bundle)) {
        if (item === htmlAsset) continue;
        const escaped = fileName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        if (item.type === "chunk") {
          const code = item.code.replace(/<\/script/gi, "<\\/script");
          html = html.replace(new RegExp(`<script[^>]+src=["'][^"']*${escaped}["'][^>]*><\\/script>`), () => `<script type="module">${code}</script>`);
          delete bundle[fileName];
        } else if (fileName.endsWith(".css")) {
          html = html.replace(new RegExp(`<link[^>]+href=["'][^"']*${escaped}["'][^>]*>`), () => `<style>${String(item.source)}</style>`);
          delete bundle[fileName];
        }
      }
      htmlAsset.source = html;
    },
  };
}

export default defineConfig({
  root: "widget",
  plugins: [react(), tailwindcss(), inlineMcpAppBundle()],
  build: {
    outDir: "../dist/widget",
    emptyOutDir: true,
    target: "es2022",
    cssCodeSplit: false,
    assetsInlineLimit: Number.POSITIVE_INFINITY,
  },
});
