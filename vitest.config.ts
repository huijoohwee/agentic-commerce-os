import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: [
      'test/invocation/**/*.test.ts',
      'test/shared/**/*.test.ts',
    ],
    exclude: ['test/workers/**'],
  },
})
