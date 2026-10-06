/**
 * AIR background-work extension: project the harness's subagent and detached-job
 * lifecycle onto the ACP stream.
 *
 * The wire contract is the draft `agentclientprotocol/agent-client-protocol#1992`,
 * which claude-agent-acp already implements. The published TypeScript SDK does
 * not carry its types yet, so the compatibility boundary lives in this file:
 * when the draft ships in the SDK, delete the local shapes and the one cast.
 *
 * Every update reaches only a client that negotiated the matching
 * `_meta.jetbrains.air` capability during initialize. A client that does not
 * advertise it sees exactly the standard ACP surface it saw before.
 *
 * @module @deepseek-ai/dsh-acp/background-tasks
 */

import type { SessionNotification } from '@agentclientprotocol/sdk'

const AIR_META_NAMESPACE = 'jetbrains'
const AIR_META_KEY = 'air'
const AIR_META_VERSION = 1

/** The `_meta.jetbrains.air` capabilities this bridge implements. */
export const AIR_NATIVE_SUBAGENT_SESSIONS = 'nativeSubagentSessions'
export const AIR_ASYNC_TASKS = 'asyncTasks'

/** Params of the draft `_session/async_task/stop` extension request. */
export type AsyncTaskStopParams = {
  sessionId?: unknown
  asyncTaskId?: unknown
}

/** Terminal subagent state, as the draft defines it. */
export type SubagentState = 'completed' | 'failed' | 'cancelled' | 'disconnected'

/** Async-task state; `running` and `paused` are live, the rest are terminal. */
export type AsyncTaskState = 'running' | 'paused' | 'completed' | 'failed' | 'stopped'

/** Announcement of one child session the harness started for a subagent. */
export type SubagentSpawnedUpdate = {
  sessionUpdate: 'subagent_spawned'
  subagentSessionId: string
  name: string
  task: string
  capabilities: { cancel?: boolean; close?: boolean }
}

/** Terminal transition of one subagent run. */
export type SubagentStateUpdate = {
  sessionUpdate: 'subagent_state_update'
  subagentSessionId: string
  state: SubagentState
}

/** Announcement of one detached background job. */
export type AsyncTaskSpawnedUpdate = {
  sessionUpdate: 'async_task_spawned'
  asyncTaskId: string
  name: string
  taskType: string
  description: string
  showInTranscript: boolean
  canStop: boolean
}

/** Progress narration of one detached background job. */
export type AsyncTaskProgressUpdate = {
  sessionUpdate: 'async_task_progress'
  asyncTaskId: string
  description?: string
  lastToolName?: string
}

/** Terminal transition of one detached background job. */
export type AsyncTaskStateUpdate = {
  sessionUpdate: 'async_task_state_update'
  asyncTaskId: string
  state: AsyncTaskState
}

/** The draft update variants this bridge can project. */
export type BackgroundWorkUpdate =
  | SubagentSpawnedUpdate
  | SubagentStateUpdate
  | AsyncTaskSpawnedUpdate
  | AsyncTaskProgressUpdate
  | AsyncTaskStateUpdate

/**
 * Wrap one draft update as a standard session notification.
 *
 * This single structural cast stands in for the missing SDK types; the
 * connection serializes the extra `sessionUpdate` variants verbatim.
 * @param sessionId - the owning ACP session.
 * @param update - the draft update to send.
 * @returns the notification to hand the connection.
 */
export function backgroundWorkNotification(
  sessionId: string,
  update: BackgroundWorkUpdate,
): SessionNotification {
  return { sessionId, update } as unknown as SessionNotification
}

/**
 * Whether the client advertised one capability through
 * `clientCapabilities._meta.jetbrains.air`.
 *
 * Mirrors claude-agent-acp: the extension version must be an integer of at
 * least 1 and the capability must appear in the advertised list. Anything
 * else — an older client, another vendor, a malformed bag — is not capable.
 * @param capabilities - the raw `clientCapabilities` from initialize.
 * @param capability - one of {@link AIR_NATIVE_SUBAGENT_SESSIONS} or {@link AIR_ASYNC_TASKS}.
 * @returns true only when the client declared that capability.
 */
export function clientSupportsAir(capabilities: unknown, capability: string): boolean {
  const meta = asRecord(asRecord(capabilities)['_meta'])
  const air = asRecord(asRecord(meta[AIR_META_NAMESPACE])[AIR_META_KEY])
  const version = air['version']
  const advertised = air['capabilities']
  return typeof version === 'number'
    && Number.isInteger(version)
    && version >= AIR_META_VERSION
    && Array.isArray(advertised)
    && advertised.includes(capability)
}

/** Map a harness subagent stop reason onto the draft's terminal state. */
export function subagentStateOf(stopReason: string): SubagentState {
  switch (stopReason) {
    case 'completed': return 'completed'
    case 'aborted':
    case 'interrupted': return 'cancelled'
    case 'max-tokens':
    case 'blocked':
    case 'error': return 'failed'
    default: return 'disconnected'
  }
}

/** Map a settled job's status onto the draft's terminal async-task state. */
export function asyncTaskStateOf(status: string): AsyncTaskState {
  switch (status) {
    case 'failed': return 'failed'
    case 'killed': return 'stopped'
    default: return 'completed'
  }
}

/** Read one object-shaped value, treating every non-object as an empty bag. */
function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
}
