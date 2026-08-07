import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // The integration suites share one Dovecot container, and Drafts is written
    // by the draft suite while the search suite asserts absolute counts on it.
    // Run those files one at a time; unit tests keep the parallel default.
    fileParallelism: !process.env.RUN_INTEGRATION,
  },
});
