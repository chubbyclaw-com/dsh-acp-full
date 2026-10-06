# @chubbyclaw/dsh-acp-full

A fork of [`@deepseek-ai/dsh-acp`](https://www.npmjs.com/package/@deepseek-ai/dsh-acp) — the
automation-only ACP server inside [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) —
that also reports **background work** (subagents and detached jobs) over the ACP stream.

The upstream ACP surface carries only committed messages, thoughts, generic tool
lifecycle, configuration and context usage. A platform driving a harness agent
therefore cannot tell that the agent dispatched a subagent or left a shell
running in the background. This fork adds exactly that, using the draft
[`agent-client-protocol#1992`](https://github.com/agentclientprotocol/agent-client-protocol/pull/1992)
notifications that `claude-agent-acp` already implements.

## What it adds

Emitted only to a client that negotiated the capability in
`clientCapabilities._meta.jetbrains.air`; every other client sees the stock ACP
surface, byte for byte.

| Capability | Emitted updates | Source |
| --- | --- | --- |
| `nativeSubagentSessions` | `subagent_spawned`, `subagent_state_update` | the harness `session/created` and `subagent/end` lifecycle |
| `asyncTasks` | `async_task_spawned`, `async_task_progress`, `async_task_state_update` | the `ctx.jobs` registry |

It also answers the draft `_session/async_task/stop` extension request by
killing the named job, so a client can stop one detached job without touching
the main turn.

Everything is one structural cast away from the published SDK types, isolated in
`src/background-tasks.ts`; when the draft ships in
`@agentclientprotocol/sdk`, that file shrinks to nothing.

## Install into a DSH profile

The plugin is a drop-in replacement for the `acp` row of the stock `acp`
profile. Create a profile from the `acp` template and point the row at this
package:

```sh
dsh fullacp --from-default-profile acp
dsh plugin --profile fullacp add @chubbyclaw/dsh-acp-full   # or file:/path, or github:chubbyclaw-com/dsh-acp-full
```

Then in `$DSH_HOME/profiles/fullacp/cordis.patch.yml`:

```yaml
- id: acp
  disabled: true

- insert:
    - id: acp-full
      name: '@chubbyclaw/dsh-acp-full'
      inject: [acpAppStartup]
      config:
        provider: deepseek-official
        model: deepseek-v4-flash
```

Boot it with `dsh --profile fullacp`.

## Notes

- Built against `@deepseek-ai/dsh-*@0.2.1-alpha.1`. The `lib/` bundle is
  committed so no build step runs on install; the matching source lives in
  `src/`.
- The platform client must advertise `_meta.jetbrains.air` and read the raw
  frames: the published `@agentclientprotocol/sdk` client rejects unknown
  `sessionUpdate` variants in its strict schema, while the server sends them
  unchanged.
- MIT, same as upstream.
