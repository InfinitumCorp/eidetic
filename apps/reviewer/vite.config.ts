import path from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@eidetic/ui": path.resolve(__dirname, "../../packages/ui/src/index.ts"),
      "@eidetic/analytics": path.resolve(__dirname, "../../packages/analytics/src/index.ts"),
    },
    dedupe: ["react", "react-dom"],
  },
  server: {
    host: "0.0.0.0",
    port: 43111,
    strictPort: true,
    proxy: { "/v1": "http://127.0.0.1:43110" },
  },
  preview: {
    host: "0.0.0.0",
    port: 43111,
    strictPort: true,
    proxy: { "/v1": "http://127.0.0.1:43110" },
  },
});
