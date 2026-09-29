import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['{apps,packages}/*/test/**/*.test.{ts,tsx}', 'pipelines/test/**/*.test.ts'],
  },
});
