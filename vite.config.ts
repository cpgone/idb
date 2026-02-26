import { defineConfig } from "vite";
import react from "@vitejs/plugin-react-swc";
import path from "path";
import { componentTagger } from "lovable-tagger";

// https://vitejs.dev/config/
export default defineConfig(({ mode }) => ({
  // Use relative paths in production so the app
  // works correctly when served from a non-root
  // path or behind a reverse proxy.
  // For GitHub Pages, the project is served from /intdash/
  base: mode === "development" ? "/" : "/idb3/",
  server: {
    host: "10.78.15.242",
    port: 8080,
  },
  preview: {
    host: "10.78.15.118",
    port: 8081,
  },
  plugins: [react(), mode === "development" && componentTagger()].filter(Boolean),
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
}));
