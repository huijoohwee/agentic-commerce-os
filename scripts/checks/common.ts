import fs from 'node:fs'
import path from 'node:path'

export type Assertion = Readonly<{ condition: boolean; detail: string }>

export function fileContains(relativePath: string, pattern: RegExp | string): Assertion {
  if (!fs.existsSync(path.resolve(relativePath))) return Object.freeze({ condition: false, detail: `${relativePath}: missing` })
  const text = fs.readFileSync(path.resolve(relativePath), 'utf8')
  const condition = typeof pattern === 'string' ? text.includes(pattern) : pattern.test(text)
  return Object.freeze({ condition, detail: `${relativePath}: required contract` })
}

export function fileExists(relativePath: string): Assertion {
  return Object.freeze({ condition: fs.existsSync(path.resolve(relativePath)), detail: `${relativePath}: exists` })
}

export function report(name: string, assertions: readonly Assertion[]): void {
  const failures = assertions.filter(({ condition }) => !condition).map(({ detail }) => detail)
  process.stdout.write(`${JSON.stringify({
    ok: failures.length === 0,
    check: name,
    assertionCount: assertions.length,
    failures,
  })}\n`)
  if (failures.length > 0) process.exitCode = 1
}

export function readJson<T>(relativePath: string): T {
  return JSON.parse(fs.readFileSync(path.resolve(relativePath), 'utf8')) as T
}

export function source(relativePath: string): string {
  return fs.readFileSync(path.resolve(relativePath), 'utf8')
}
