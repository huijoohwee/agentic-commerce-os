import { validateAuthoredLimits } from '../validate-authored-limits.ts'

const verdict = validateAuthoredLimits(process.cwd())
process.stdout.write(`${JSON.stringify({ ...verdict, check: 'authored-limits' })}\n`)
if (!verdict.ok) process.exitCode = 1
