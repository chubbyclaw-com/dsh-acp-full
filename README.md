# @chubbyclaw/dsh-acp-full

A patch over [`@deepseek-ai/dsh-acp`](https://www.npmjs.com/package/@deepseek-ai/dsh-acp) — the
automation-only ACP server inside [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) —
that also reports **background work** (subagents and detached jobs) over the ACP stream.

The upstream ACP surface carries only committed messages, thoughts, generic tool
lifecycle, configuration and context usage. A platform driving a harness agent
therefore cannot tell that the agent dispatched a subagent or left a shell
running in the background. This change adds exactly that, using the draft
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

## How it runs

The harness stays stock DeepSeek Harness. This package is a **profile** for it,
so the launch line still names the upstream binary:

```sh
npx -y @deepseek-ai/dsh@0.2.1-alpha.1 --profile chubbyclaw-full-acp
```

The package ships both halves:

- `lib/` — the patched bridge, a drop-in replacement for the stock `acp` row;
- `profile/` — the ready `chubbyclaw-full-acp` profile: it disables the stock
  `acp` row and inserts this bridge, and declares which `dsh` runtime it targets
  (`package.json` → `chubbyclaw.dshRuntimeVersion`).

`cclaw` prepares that profile for the owner with no pnpm, no clone and no extra
install step: `npm pack @chubbyclaw/dsh-acp-full`, extract `lib/` into
`$DSH_HOME/profiles/chubbyclaw-full-acp/node_modules/@chubbyclaw/dsh-acp-full/`
and `profile/` into the profile root, then launch the pinned `dsh` above. The
bridge's `@deepseek-ai/dsh-*` imports resolve to the harness installation, so no
dependency tree is installed.

## Repository layout

This is the only repository: the change lives as a patch over upstream, not as a
fork of the whole harness.

| Path | What it is |
| --- | --- |
| `lib/` | the built bundle and declarations — what npm ships |
| `profile/` | the `chubbyclaw-full-acp` DSH profile template |
| `patches/` | the change over upstream, one patch per commit |
| `scripts/build.sh` | rebuilds `lib/` from upstream at the pinned tag |

## Rebuild

```sh
scripts/build.sh          # clone upstream at chubbyclaw.dshRuntimeVersion, patch, build, copy lib/
scripts/build.sh --test   # also run the upstream ACP test suite
```

`DSH_UPSTREAM_TAG` overrides the tag (default `dsh-v<chubbyclaw.dshRuntimeVersion>`).
Bumping to a newer harness means bumping `chubbyclaw.dshRuntimeVersion`, refreshing
the patch against the new tag, rebuilding, and publishing a new version.

## Notes

- Built against `@deepseek-ai/dsh-*@0.2.1-alpha.1`; the peer versions are exact, so
  the loader only activates the bridge on that runtime. Widen them (and re-verify)
  only when a range has actually been tested.
- The platform client must advertise `_meta.jetbrains.air` and read the raw
  frames: the published `@agentclientprotocol/sdk` client rejects unknown
  `sessionUpdate` variants in its strict schema, while the server sends them
  unchanged.
- MIT, same as upstream.
