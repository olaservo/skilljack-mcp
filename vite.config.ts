import { defineConfig } from "vite";
import { viteSingleFile } from "vite-plugin-singlefile";
import path from "node:path";

export default defineConfig({
  root: "src/ui",
  plugins: [viteSingleFile()],
  build: {
    outDir: path.resolve(__dirname, "dist/ui"),
    emptyOutDir: true,
    rollupOptions: {
      input: path.resolve(__dirname, "src/ui/mcp-app.html"),
    },
  },
});
