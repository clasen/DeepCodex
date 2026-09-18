---
name: delegate-flash
description: Delegate bounded coding tasks to native DeepSeek Flash subagents in Codex through DeepCodex. Use when DeepCodex or Flash delegation is requested, or when diagnosing the Desktop integration.
---

# DeepCodex

Keep the coordinator on the user's selected native model. DeepSeek Flash runs as
an actual Codex subagent through the local DeepCodex router. Use the native
collaboration tools for spawning, follow-ups, waiting, and interruption; the
normal delegation path does not launch a separate `codex exec` worker.

## Delegate

Choose an independently verifiable task and give the child the objective,
necessary context, allowed files, exclusions, acceptance checks, and the user's
communication language. Preserve the language of existing code. Review the
actual changes and verification before declaring the user's task complete.

When the current tool schema offers `deepseek-flash`, call `spawn_agent` with
`model="deepseek-flash"`, `reasoning_effort="high"`, and `fork_turns="none"`.
A fresh child receives the bounded ticket without copying the full conversation.
Keep its returned identity and use `followup_task` for related work in the same
agent. Use `wait_agent` and `interrupt_agent` normally. Never invent unavailable
model overrides or disguise DeepSeek under an OpenAI model name.

If the schema does not offer Flash, check installation status and ask the user to
fully quit/reopen Desktop and start a new task after a configuration update.
Do not silently switch to a separate process or another provider. Existing tasks
can retain the previous provider and model catalog.

Subagents inherit Codex's permissions. A ticket's allowed files are instructions,
not a filesystem sandbox. Use isolation when the task needs it. Do not claim the
worker cannot read secrets accessible to the same user.

## Local integration

Resolve plugin paths relative to this installed skill (the root is two levels
above). The source launcher is `scripts/desktop.js`; the installed user service
runs the stable copy under `~/.local/share/deepcodex/runtime`. Operational policy
is in `config/desktop.json`, shared transport defaults in `config/pilot.json`,
and the DeepSeek model and credential path in `config/worker.json`.

Run `node <plugin>/scripts/desktop.js status` to check the local service without
inference. The service is `com.deepcodex.router`, bound only to loopback: LaunchAgent on
macOS, systemd user service on Linux, and a scheduled logon task on Windows. Private
state and bounded metadata receipts live in `~/.config/deepcodex/desktop`.
Receipts contain routing and tool names, not prompts, tool arguments or tokens.
Do not print `state.json`, provider headers, credential files or full user config.

DeepSeek credentials stay in `~/.config/deepcodex/.env` outside the plugin and
are read by the service. Never ask for a key in chat or package `.env` files.
The router forwards native Codex authentication only to OpenAI and the DeepSeek
key only to DeepSeek. Native encrypted task handoffs use an additional OpenAI
relay call; delegation consumes both Codex quota and DeepSeek API usage.

`node <plugin>/scripts/desktop.js install` writes the service and user-level
provider/catalog settings. Run it only when the user authorizes activation or
repair. It preserves unrelated settings and keeps a private pre-install config
backup. Do not restore that full backup over later user changes without review.

The opt-in `scripts/pilot.js` runs an isolated live test and spends API usage.
A healthy service or visible model is not proof that a live delegated task ran.
Report separately configuration, CLI/API execution, and Desktop UI evidence.
