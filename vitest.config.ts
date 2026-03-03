import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  define: {
    __ANDROID_ONLY__: JSON.stringify(false),
  },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./vitest.setup.ts"],
    coverage: {
      provider: "v8",
      include: [
        "services/**/*.ts",
        "components/**/*.tsx",
        "hooks/**/*.ts",
        "src/**/*.ts",
        "src/**/*.tsx",
        "utils/**/*.ts",
      ],
      exclude: [
        "**/*.test.*",
        "**/*.spec.*",
        "**/vitest.setup.ts",
        "node_modules",
        "dist",
        "coverage",
      ],
      reporter: ["text", "text-summary", "html"],
      thresholds: {
        lines: 25,
        functions: 25,
        branches: 25,
        statements: 25,
      },
    },
  },
});
