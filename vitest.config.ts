import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["src/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/ui/**", "src/**/*.test.ts", "src/__fixtures__/**", "src/__test-helpers__/**"],
      reporter: ["text", "lcov"],
    },
    restoreMocks: true,
    mockReset: true,
  },
});
