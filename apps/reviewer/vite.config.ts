import path from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

// Cumulus ID issuer for /cumulus-bar.js (the account bar). VITE_CID_ISSUER points it at a mirror (e.g. one that loads in Russia).
const cidIssuer = (): Plugin => ({
  name: "cid-issuer",
  transformIndexHtml: (html) =>
    html.replace("%CID_ISSUER%", (process.env.VITE_CID_ISSUER || "https://id.cumuluscloud.app").replace(/\/+$/, "")),
});

export default defineConfig({
  plugins: [react(), cidIssuer()],
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
