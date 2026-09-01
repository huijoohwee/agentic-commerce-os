import { spawn } from 'node:child_process'

import type { CommandEnvironment } from './environment.ts'

const MAXIMUM_COMMAND_OUTPUT_BYTES = 65_536
const MAXIMUM_COMMAND_INPUT_BYTES = 1_000_000

export type CommandKind = 'observation' | 'mutation' | 'check'

export type CommandInvocation = Readonly<{
  id: string
  kind: CommandKind
  executable: string
  args: readonly string[]
  stdin?: string
  timeoutMs: number
}>

export type CommandExecution = Readonly<{
  exitCode: number
  stdout: string
  stderr: string
  durationMs: number
  outputTruncated: boolean
}>

export type CommandRunner = Readonly<{
  run(invocation: CommandInvocation): Promise<CommandExecution>
}>

export type LocalCommandRunnerOptions = Readonly<{ environment?: CommandEnvironment }>

export function createLocalCommandRunner(
  workingDirectory: string,
  options: LocalCommandRunnerOptions = {},
): CommandRunner {
  if (!workingDirectory || workingDirectory.includes('\0')) throw new Error('merge_agent_working_directory_invalid')
  return Object.freeze({
    run(invocation) {
      validateInvocation(invocation)
      return execute(workingDirectory, invocation, options.environment)
    },
  })
}

async function execute(
  workingDirectory: string,
  invocation: CommandInvocation,
  environment?: CommandEnvironment,
): Promise<CommandExecution> {
  const startedAtMs = Date.now()
  const child = spawn(invocation.executable, [...invocation.args], {
    cwd: workingDirectory,
    shell: false,
    stdio: ['pipe', 'pipe', 'pipe'],
    timeout: invocation.timeoutMs,
    windowsHide: true,
    ...(environment ? { env: environment as NodeJS.ProcessEnv } : {}),
  })
  let stdout = ''
  let stderr = ''
  let outputTruncated = false
  child.stdout.on('data', (chunk: Buffer) => {
    const appended = appendBounded(stdout, chunk)
    stdout = appended.value
    outputTruncated ||= appended.truncated
  })
  child.stderr.on('data', (chunk: Buffer) => {
    const appended = appendBounded(stderr, chunk)
    stderr = appended.value
    outputTruncated ||= appended.truncated
  })
  if (invocation.stdin !== undefined) child.stdin.end(invocation.stdin)
  else child.stdin.end()

  return new Promise((resolve) => {
    let spawnError = ''
    child.once('error', (error) => {
      spawnError = error instanceof Error ? error.message : 'command_spawn_failed'
    })
    child.once('close', (code, signal) => {
      const failure = spawnError || (signal ? `terminated_by_${signal}` : '')
      resolve(Object.freeze({
        exitCode: code ?? 1,
        stdout,
        stderr: boundedText([stderr, failure].filter(Boolean).join('\n')),
        durationMs: Math.max(0, Date.now() - startedAtMs),
        outputTruncated,
      }))
    })
  })
}

function validateInvocation(invocation: CommandInvocation): void {
  if (!bounded(invocation.id)
    || !/^[A-Za-z0-9._/-]{1,256}$/u.test(invocation.executable)
    || invocation.args.length > 128
    || invocation.args.some((argument) => !bounded(argument))
    || !Number.isSafeInteger(invocation.timeoutMs)
    || invocation.timeoutMs < 1
    || invocation.timeoutMs > 1_800_000
    || Buffer.byteLength(invocation.stdin ?? '') > MAXIMUM_COMMAND_INPUT_BYTES) {
    throw new Error('merge_agent_command_invalid')
  }
}

function appendBounded(current: string, chunk: Buffer): Readonly<{ value: string; truncated: boolean }> {
  if (Buffer.byteLength(current) >= MAXIMUM_COMMAND_OUTPUT_BYTES) {
    return Object.freeze({ value: current, truncated: true })
  }
  const remaining = MAXIMUM_COMMAND_OUTPUT_BYTES - Buffer.byteLength(current)
  const text = new TextDecoder().decode(chunk.subarray(0, remaining))
  return Object.freeze({ value: current + text, truncated: chunk.byteLength > remaining })
}

function boundedText(value: string): string {
  return new TextDecoder().decode(Buffer.from(value).subarray(0, MAXIMUM_COMMAND_OUTPUT_BYTES))
}

function bounded(value: string): boolean {
  return value === value.trim() && value.length > 0 && value.length <= 4_096 && !value.includes('\0')
}
