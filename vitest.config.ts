import { readFileSync } from 'node:fs'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  plugins: [{ name: 'worker-text-assets', enforce: 'pre', load(id) {
    if (id.endsWith('.client.js')) return 'export default ' + JSON.stringify(readFileSync(id, 'utf8'))
  } }],
  test: {
    environment: 'node',
    include: [
      'test/invocation/**/*.test.ts',
      'test/shared/**/*.test.ts',
    ],
    exclude: ['test/workers/**'],
  },
})
