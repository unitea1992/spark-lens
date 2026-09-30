import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  root: "web",
  plugins: [react()],
  // Font subsets are tiny; inlining them would put every glyph range into the CSS.
  build: { outDir: "../dist", emptyOutDir: true, assetsInlineLimit: 0 },
  server: {
    // `pnpm dev:web` serves the client with hot reload against a running `pnpm dev`.
    proxy: { "/api": "http://127.0.0.1:8686" },
  },
});
