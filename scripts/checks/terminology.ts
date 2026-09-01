import { validateTerminology } from '../validate-terminology-register.ts'

const verdict = validateTerminology(process.cwd())
process.stdout.write(`${JSON.stringify({ ...verdict, check: 'terminology' })}\n`)
if (!verdict.ok) process.exitCode = 1
