import { mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

export const PLUGIN = 'session-log'

export type Engine = Parameters<Extract<Parameters<typeof test>[1], (...args: never[]) => unknown>>[0]

// 指示の id は送信時刻なので、送るたびに時計を進めて重ならないようにする
export const setup = (on: On) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  on('prompt.submit', (_$, e) => ({ text: e.text }))
  on('prompt.attachment', (_$, e) => ({ text: e.text }))
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  return clock
}

export const submit = async ($: Engine, clock: ReturnType<typeof mock.clock>, text: string, turnId?: string) => {
  await clock.advance(1000)
  await $.prompt.submit({ text, origin: { kind: 'composer' }, wait: false, ...(turnId ? { turnId } : {}) })
}

export const complete = ($: Engine, turnId: string, reason: 'answer' | 'aborted') =>
  $.turn.complete({ reason, answer: '', durationMs: 0, isAborted: reason === 'aborted', turnId })

// 状態はペインに描いたものから読む
export const paneText = async ($: Engine, surface: 'terminal' | 'desktop' = 'terminal') => {
  const ui = await $.ui.mount({
    plugin: PLUGIN,
    surface,
    component: 'Pane',
    requestId: PLUGIN,
    props: { title: '指示の履歴', isFocused: false },
  } as never)
  const texts = (await ui.findAll({ type: 'Text' })).map(element => element.text)
  await ui.unmount()
  return texts.join('\n')
}
