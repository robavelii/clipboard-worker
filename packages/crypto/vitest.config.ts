import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // WebCrypto is a global in Node >= 20, so these run unmodified.
    environment: "node",
    include: ["test/**/*.test.ts"],
    testTimeout: 30_000, // PBKDF2 at 600k iterations is not instant.
  },
});
