import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: { alias: { "@": path.resolve(__dirname, "src") } },
  esbuild: { jsx: "automatic" },
  test: {
    environment: "node",
    include: [
      "src/components/reader/immersive-translation/**/*.test.{ts,tsx}",
      "src/components/reader/epub-translation/**/*.test.{ts,tsx}",
      "src/components/reader/reader-capabilities.test.ts",
      "src/lib/reader/theme.test.ts",
      "src/lib/platform/tauri-platform-service.test.ts",
    ],
  },
});
