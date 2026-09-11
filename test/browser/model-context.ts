import type { Page } from '@playwright/test'

export type WebMcpHarness = {
  completedAt: number | null
  definitions: Array<Readonly<Record<string, unknown>>>
  live: Array<Readonly<{ name: string; inputSchema: unknown }>>
}

export async function installModelContextHarness(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const harness = {
      completedAt: null as number | null,
      definitions: [] as Array<Readonly<Record<string, unknown>>>,
      live: [] as Array<Readonly<{ name: string; inputSchema: unknown }>>,
    }
    Reflect.set(globalThis, '__webMcpHarness', harness)
    Object.defineProperty(Reflect.get(globalThis, 'document'), 'modelContext', {
      configurable: true,
      value: {
        async registerTool(definition: Readonly<Record<string, unknown>>, options?: { signal?: AbortSignal }) {
          if (options?.signal?.aborted) throw options.signal.reason
          harness.definitions.push(definition)
          harness.live.push({ name: String(definition.name), inputSchema: definition.inputSchema })
          harness.completedAt = performance.now()
        },
        async getTools() { return harness.live },
      },
    })
  })
}

