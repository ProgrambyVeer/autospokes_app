import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [tailwindcss(), react()],
  server: {
    proxy: {
      "/auth": "http://127.0.0.1:3001",
      "/owner": "http://127.0.0.1:3001",
      "/detailer": "http://127.0.0.1:3001",
      "/society": "http://127.0.0.1:3001",
    },
  },
  test: {
    environment: "jsdom",
    setupFiles: ["./src/test-setup.ts"],
    include: ["src/**/*.test.tsx"],
  },
});
