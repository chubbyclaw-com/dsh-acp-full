import { afterEach, describe, expect, it, vi } from 'vitest'
import { PROTOCOL_VERSION } from '@agentclientprotocol/sdk'
import type { Context } from '@deepseek-ai/cordis'
import type { Session } from '@deepseek-ai/dsh-session'
import {
  AIR_ASYNC_TASKS,
  AIR_NATIVE_SUBAGENT_SESSIONS,
  asyncTaskStateOf,
  backgroundWorkNotification,
  clientSupportsAir,
  subagentStateOf,
} from '../src/background-tasks.ts'
import { makeBridgeHarness, type BridgeHarness } from './harness.ts'

/** The `clientCapabilities` a capable platform sends: both draft capabilities. */
const AIR_CAPABILITIES = {
  _meta: {
    jetbrains: {
      air: {
        version: 1,
        capabilities: [AIR_NATIVE_SUBAGENT_SESSIONS, AIR_ASYNC_TASKS],
      },
    },
  },
}

/** Emit one context event without fighting the branded lifecycle payloads. */
function emit(ctx: Context, name: string, ...args: unknown[]): void {
  (ctx.emit as unknown as (event: string, ...eventArgs: unknown[]) => void)(name, ...args)
}

/** A child-session stand-in; the bridge reads only its id and parent. */
function childSession(id: string, parent: string): Session {
  return { id, header: { parentSession: parent } } as unknown as Session
}

/** One job view as the bridge reads it. */
function job(overrides: Record<string, unknown>): Record<string, unknown> {
  return { id: 'bash-1', kind: 'bash', label: 'sleep 999', status: 'running', ...overrides }
}

describe('AIR background-work capability negotiation', () => {
  it('accepts only a versioned, listed capability', () => {
    expect(clientSupportsAir(AIR_CAPABILITIES, AIR_ASYNC_TASKS)).toBe(true)
    expect(clientSupportsAir(AIR_CAPABILITIES, AIR_NATIVE_SUBAGENT_SESSIONS)).toBe(true)
    expect(clientSupportsAir(AIR_CAPABILITIES, 'diffPatch')).toBe(false)
    const oldVersion = { _meta: { jetbrains: { air: { version: 0, capabilities: [AIR_ASYNC_TASKS] } } } }
    const fractionalVersion = { _meta: { jetbrains: { air: { version: 1.5, capabilities: [AIR_ASYNC_TASKS] } } } }
    const notAList = { _meta: { jetbrains: { air: { version: 1, capabilities: 'asyncTasks' } } } }
    expect(clientSupportsAir(oldVersion, AIR_ASYNC_TASKS)).toBe(false)
    expect(clientSupportsAir(fractionalVersion, AIR_ASYNC_TASKS)).toBe(false)
    expect(clientSupportsAir(notAList, AIR_ASYNC_TASKS)).toBe(false)
    expect(clientSupportsAir({}, AIR_ASYNC_TASKS)).toBe(false)
    expect(clientSupportsAir(undefined, AIR_ASYNC_TASKS)).toBe(false)
  })
})

describe('draft state mapping', () => {
  it('maps every harness subagent outcome onto a draft terminal state', () => {
    expect(subagentStateOf('completed')).toBe('completed')
    expect(subagentStateOf('aborted')).toBe('cancelled')
    expect(subagentStateOf('interrupted')).toBe('cancelled')
    expect(subagentStateOf('max-tokens')).toBe('failed')
    expect(subagentStateOf('blocked')).toBe('failed')
    expect(subagentStateOf('error')).toBe('failed')
    expect(subagentStateOf('something-new')).toBe('disconnected')
  })

  it('maps a settled job status onto a draft terminal state', () => {
    expect(asyncTaskStateOf('completed')).toBe('completed')
    expect(asyncTaskStateOf('killed')).toBe('stopped')
    expect(asyncTaskStateOf('failed')).toBe('failed')
    expect(asyncTaskStateOf('running')).toBe('completed')
  })

  it('wraps a draft update as a session notification', () => {
    const notification = backgroundWorkNotification('session-1', {
      sessionUpdate: 'subagent_state_update',
      subagentSessionId: 'child-1',
      state: 'completed',
    })
    expect(notification).toEqual({
      sessionId: 'session-1',
      update: { sessionUpdate: 'subagent_state_update', subagentSessionId: 'child-1', state: 'completed' },
    })
  })
})

describe('background work reporting over the bridge', () => {
  let harness: BridgeHarness | undefined

  afterEach(async () => {
    await harness?.dispose()
    harness = undefined
  })

  /**
   * Notifications are asserted on the raw wire, not through the SDK client:
   * the published SDK's strict schema drops the draft `sessionUpdate` variants
   * that a raw-frame client like cclaw reads.
   */
  const raw = (): { sessionId: string; update: Record<string, unknown> }[] => harness?.rawUpdates ?? []

  async function open(options: { jobs?: boolean; capabilities?: unknown } = {}): Promise<string> {
    harness = await makeBridgeHarness(options.jobs === true ? { jobs: true } : {})
    await harness.client.initialize({
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: options.capabilities ?? AIR_CAPABILITIES,
    })
    const { sessionId } = await harness.client.newSession({ cwd: process.cwd(), mcpServers: [] })
    return sessionId
  }

  it('reports a subagent lifecycle to a capable client', async () => {
    const sessionId = await open()

    emit(harness!.ctx, 'session/created', childSession('child-1', sessionId))
    await vi.waitFor(() => {
      expect(raw()).toContainEqual({
        sessionId,
        update: {
          sessionUpdate: 'subagent_spawned',
          subagentSessionId: 'child-1',
          name: 'subagent',
          task: '',
          capabilities: {},
        },
      })
    })

    emit(harness!.ctx, 'subagent/end', { id: 'child-1', runId: 'run-1', provider: 'spawn', local: true, stopReason: 'completed' })
    await vi.waitFor(() => {
      expect(raw()).toContainEqual({
        sessionId,
        update: { sessionUpdate: 'subagent_state_update', subagentSessionId: 'child-1', state: 'completed' },
      })
    })
  })

  it('stays silent for a client that did not negotiate the capability', async () => {
    const sessionId = await open({ capabilities: {} })

    emit(harness!.ctx, 'session/created', childSession('child-9', sessionId))
    emit(harness!.ctx, 'subagent/end', { id: 'child-9', runId: 'run-9', provider: 'spawn', local: true, stopReason: 'completed' })
    await new Promise(resolve => setTimeout(resolve, 25))

    expect(raw().some(entry => String(entry.update.sessionUpdate).startsWith('subagent_'))).toBe(false)
  })

  it('reports a detached job through the job registry', async () => {
    const sessionId = await open({ jobs: true })
    expect(harness!.ctx.get('jobs')).toBe(harness!.jobs)

    harness!.jobs!.emit({ type: 'registered', job: job({ owner: sessionId }) })
    await vi.waitFor(() => {
      expect(raw()).toContainEqual({
        sessionId,
        update: {
          sessionUpdate: 'async_task_spawned',
          asyncTaskId: 'bash-1',
          name: 'sleep 999',
          taskType: 'bash',
          description: '',
          showInTranscript: false,
          canStop: true,
        },
      })
    })

    harness!.jobs!.emit({ type: 'progress', job: job({ owner: sessionId, progress: '3/10' }) })
    await vi.waitFor(() => {
      expect(raw()).toContainEqual({
        sessionId,
        update: { sessionUpdate: 'async_task_progress', asyncTaskId: 'bash-1', description: '3/10' },
      })
    })

    harness!.jobs!.emit({ type: 'settled', job: job({ owner: sessionId, status: 'completed' }) })
    await vi.waitFor(() => {
      expect(raw()).toContainEqual({
        sessionId,
        update: { sessionUpdate: 'async_task_state_update', asyncTaskId: 'bash-1', state: 'completed' },
      })
    })
  })

  it('does not double-report a background subagent job', async () => {
    const sessionId = await open({ jobs: true })

    harness!.jobs!.emit({ type: 'registered', job: job({ owner: sessionId, kind: 'subagent', id: 'subagent-1' }) })
    await new Promise(resolve => setTimeout(resolve, 25))

    expect(raw().some(entry => entry.update.sessionUpdate === 'async_task_spawned')).toBe(false)
  })

  it('stops one detached job through the draft extension request', async () => {
    const sessionId = await open({ jobs: true })

    harness!.jobs!.emit({ type: 'registered', job: job({ owner: sessionId }) })
    await vi.waitFor(() => {
      expect(raw().some(entry => entry.update.sessionUpdate === 'async_task_spawned')).toBe(true)
    })

    await harness!.client.sendExtension('_session/async_task/stop', { sessionId, asyncTaskId: 'bash-1' })
    expect(harness!.jobs!.killed).toEqual([{ id: 'bash-1', caller: sessionId, reason: 'stopped by ACP client' }])
  })
})
