import { describe, expect, it } from 'vitest'

import {
  namedCheckForTask,
  parseBoundsSnapshot,
  parseTaskBounds,
  validateTaskBounds,
} from '../../scripts/validate-task-bounds'

describe('task bounds parser', () => {
  it('ignores descriptive mentions and binds only an indented bounds record', () => {
    const markdown = [
      'Read `_Bounds:_` as a documented convention.',
      '  - [ ] 1.2 Create the validator',
      '    - descriptive text containing `_Bounds:_` does not end task ownership',
      '    - _Bounds: check `npm run check:task-bounds` · tokens 10 · iterations 2 · wall-clock 3 · context 20 · breaker: repeat_',
    ].join('\n')

    expect(parseTaskBounds(markdown).bounds).toHaveLength(1)
    expect(validateTaskBounds(markdown)).toMatchObject({
      ok: true,
      taskCount: 1,
      boundsCount: 1,
      findings: [],
    })
  })

  it('does not treat an unindented bounds-shaped line as a task record', () => {
    const parsed = parseTaskBounds([
      '  - [ ] 1.2 Create the validator',
      '- _Bounds: check `not-a-record` · tokens 1 · iterations 1 · wall-clock 1 · context 1 · breaker: stop_',
    ].join('\n'))

    expect(parsed.bounds).toEqual([])
  })

  it('resolves each task to one exact portable named check', () => {
    const snapshot = parseBoundsSnapshot({
      schema: 'agentic-commerce-task-bounds-snapshot/v2',
      source: '.kiro/specs/example/tasks.md',
      sourceSha256: 'a'.repeat(64),
      taskCount: 2,
      boundsCount: 2,
      findingCount: 0,
      namedCheckGroups: [{ namedCheck: 'npm run check:example', taskIds: ['1.1', '1.2'] }],
    })

    expect(snapshot).not.toBeNull()
    expect(snapshot && namedCheckForTask(snapshot, '1.2')).toBe('npm run check:example')
    expect(parseBoundsSnapshot({
      schema: 'agentic-commerce-task-bounds-snapshot/v2',
      source: '.kiro/specs/example/tasks.md',
      sourceSha256: 'a'.repeat(64),
      taskCount: 2,
      boundsCount: 2,
      findingCount: 0,
      namedCheckGroups: [
        { namedCheck: 'first', taskIds: ['1.1'] },
        { namedCheck: 'second', taskIds: ['1.1'] },
      ],
    })).toBeNull()
  })
})
