import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

const apiProxyTarget =
  (globalThis as { process?: { env?: Record<string, string | undefined> } }).process
    ?.env?.VITE_API_PROXY_TARGET ?? "http://localhost:8000";

export default defineConfig({
  plugins: [react()],
  server: {
    host: true,
    port: 5173,
    proxy: {
      "/api": {
        target: apiProxyTarget,
        changeOrigin: true,
      },
    },
  },
  test: {
    environment: "jsdom",
    include: ["src/**/*.test.{ts,tsx}"],
  },
});
