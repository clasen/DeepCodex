# DeepCodex

DeepCodex lets you keep Astra, or your preferred native Codex model, in charge
of a task while delegating bounded work to DeepSeek Flash. The coordinator
decides what to delegate and reviews the results before integrating them.

[OpenDesign Arena](https://open-design.ai/llm-arena-for-design/) compared 13 models
on design tasks. Eleven scored lower than DeepSeek V4.1 Flash and cost more.
Only GPT-6 Astra scored higher overall:

| Model | Average score / 100 | Estimated cost per artifact |
| --- | --- | --- |
| DeepSeek V4.1 Flash | 81.2 | $0.023 |
| GPT-6 Astra | 82.7 | $1.61 |

Astra's estimated cost was 70 times Flash's for a 1.5-point gain in that design
evaluation. DeepCodex lets you choose a model per job: keep the coordinator's
judgment for work that needs it, and give Flash tasks with a clear scope and a
result you can check.

For example, the coordinator can work through a change that spans several
modules while Flash adds regression tests for an agreed behavior in a separate
file. Small tasks that cannot be split usefully can stay with the coordinator.

Flash runs as an actual Codex subagent through a local loopback router. It
appears as `deepseek-flash` in the normal collaboration tools (`spawn_agent`,
`followup_task`, `wait_agent`, `interrupt_agent`), alongside your selected native
coordinator model. Delegation consumes DeepSeek API usage and Codex quota;
encrypted task handoffs also require a native relay call. Actual savings depend
on the delegated work and the coordinator's usage. See
[Encrypted handoff relay](#encrypted-handoff-relay) for how that works.

## Get started

### 1. Install Codex and sign in

Install the desktop app using the [official setup guide](https://learn.chatgpt.com/docs/quickstart),
open Codex and sign in with your ChatGPT account. Open a local project once to
complete the initial setup. If you already use Codex, you can skip this step.

On Windows or Linux, also install the [Codex CLI](https://learn.chatgpt.com/docs/codex/cli)
and run `codex` once to sign in. On macOS, DeepCodex can use the CLI bundled with
the desktop app.

### 2. Get a DeepSeek API key

Create an account at [DeepSeek Platform](https://platform.deepseek.com/),
generate an API key and copy it for the next steps. Add API credit there if
your balance is empty.

### 3. Install DeepCodex globally

Install [Node.js](https://nodejs.org/) 22.15 or newer, which includes npm, if you
do not already have it. In a terminal, run:

```sh
npm install --global deepcodex
```

Use the same operating-system user that runs Codex. The commands work in a POSIX
shell, PowerShell or Command Prompt, from any directory.

### 4. Save your API key

```sh
deepcodex configure
```

When prompted, paste the DeepSeek API key from step 2 and press Enter. The input
is hidden. DeepCodex saves the key in `~/.config/deepcodex/.env` for the router
to use; you do not need to edit a configuration file.

### 5. Activate DeepCodex

```sh
deepcodex install
```

This checks your setup, starts the local router and installs the Codex plugin.
It configures DeepSeek Flash for delegation while keeping your selected native
model as coordinator. If a prerequisite is missing, the command reports it.

### 6. Restart Codex and start a new task

Fully quit and reopen the desktop app, or exit and restart the Codex CLI. Start
a new task so it picks up the updated provider and model catalog.

Check that the local router is running:

```sh
deepcodex status
```

This checks the service without running inference. Existing tasks keep their
original settings.

<details>
<summary>Installation details and troubleshooting</summary>

### Platform and CLI compatibility

- macOS, Linux with a running systemd user session, or Windows with PowerShell
  and Task Scheduler. Install as the user who runs Codex. WSL uses the Linux
  service and requires systemd enabled.
- Node.js >= 22.15. The worker uses `node:sqlite`, `fetch` and
  `import.meta.resolve`.
- A compatible Codex CLI, either on `PATH` or bundled with Codex Desktop.
  On macOS, when no CLI is on `PATH`, DeepCodex checks `Codex.app` and `ChatGPT.app`
  under `~/Applications` and `/Applications`, in that order. No separate CLI
  installation is needed on macOS when Desktop includes a compatible binary.
  On Windows and Linux, install a compatible Codex CLI on `PATH`. Standard npm
  Node wrappers on Windows run directly through Node, preserving literal arguments.
  Custom `.cmd`/`.bat` wrappers cannot accept `%` in paths or arguments; use the
  npm installation or a native `codex.exe` in that case.
  `codex exec` must support `--ignore-user-config`, `--ephemeral`, `--json`
  and `--strict-config`; `deepcodex doctor` verifies this before activation.
  A CLI on `PATH` takes priority, even if it is incompatible.

The default router port is `4207`; only one router can use it on a machine.

The global installation adds `deepcodex` to npm's global bin directory, which
must be on your `PATH`. In paths below, `~` means your home directory
(`%USERPROFILE%` on Windows).

### Credential storage

`configure` asks for the DeepSeek API key with hidden input on the terminal and
stores it in `~/.config/deepcodex/.env`. It creates the directory with mode
`0700` and the file with mode `0600` on macOS/Linux. On Windows it uses an
owner-only ACL. The key is stored as plaintext in that file.

The command does not accept a key argument or piped input, keeping the key out
of shell history and process arguments. Press Ctrl-C to cancel without changing
the saved key. Re-running `configure` replaces the key while preserving other
variables in the file. Run `install` again to reload an already running router.

`config/worker.json` defines the credential file location. `doctor` and `run`
prefer `DEEPSEEK_API_KEY` from their environment when set; otherwise they read
the file, as does the installed desktop service. Credentials stay outside the
repository. The file permissions restrict other users, but programs running as
your user can still read it.

### Checking prerequisites

```sh
deepcodex doctor
```

`doctor` checks the local prerequisites without running inference: that a
compatible Codex CLI is reachable and that the DeepSeek credential is present.
Run it separately when troubleshooting; `install` runs these checks automatically
and refuses to continue unless the doctor reports `ready`.
Neither `configure` nor `doctor` contacts DeepSeek to validate the key. A `ready`
result confirms local prerequisites, not provider authentication or account credit.

### What installation changes

`install` activates the desktop integration:

- copies a stable runtime (scripts, config, prompts, vendor code and the bundled
  dependency) to `~/.local/share/deepcodex/runtime`;
- writes private state, the model catalog and receipts to
  `~/.config/deepcodex/desktop`;
- installs and starts `com.deepcodex.router`, bound only to `127.0.0.1:4207`: a
  LaunchAgent on macOS, a systemd user service on Linux, or a scheduled task on
  Windows. The Windows installer builds a supervisor with the Windows GUI
  subsystem so neither the supervisor nor Node creates a console window.
  The service starts with the user session; Windows
  requires that user to be logged in;
- updates `~/.codex/config.toml` with the local provider, the subagent defaults
  and the generated model catalog, keeping a pre-install backup at
  `~/.config/deepcodex/desktop/config.before.toml`;
- registers and installs the bundled DeepCodex plugin in the personal marketplace,
  including its current name, description, icon and delegation skill;
- adds a marked DeepCodex block to the global `AGENTS.md` in `CODEX_HOME`
  (default `~/.codex`) when that block is absent. It asks Codex to consider
  delegation for suitable independent subtasks. Reinstallation replaces the
  managed block with the current instructions and preserves all text outside
  its markers; uninstall removes only that block.

The installer refuses to run when an unrelated custom provider is active or when
an endpoint override is already configured, and it leaves your configuration
untouched if the service does not become healthy.

### Installing from a checkout

From the repository, run:

```sh
pnpm install --frozen-lockfile
npm install --global .
```

Then continue from step 4 above.

</details>

## Plugin skill

The delegation skill lives in `skills/delegate-flash/SKILL.md`. `deepcodex install`
copies the plugin to `~/plugins/deepcodex`, registers it in
`~/.agents/plugins/marketplace.json`, and installs it through the Codex CLI.
Repeating the command refreshes the plugin cache even when the package version
has not changed. Other personal marketplace entries are preserved.

## Commands

| Command | Purpose |
| --- | --- |
| `deepcodex configure` | Prompt for the DeepSeek API key and write `~/.config/deepcodex/.env`. |
| `deepcodex doctor` | Check Codex CLI compatibility and credential presence without inference. |
| `deepcodex install` | Install the router runtime, user service, Codex settings and current DeepCodex plugin. |
| `deepcodex uninstall` | Stop and remove the router, restoring the saved Codex configuration. Credentials are preserved. Refuses if config changed since installation. Restart Codex afterward; remove the npm package separately with `npm uninstall -g deepcodex`. |
| `deepcodex status` | Query the installed router health endpoint without inference. |
| `deepcodex run --cwd PATH --task-file PATH [--write]` | Run one bounded isolated worker ticket against DeepSeek. Read-only unless `--write` is given. |
| `deepcodex pilot` | Run the opt-in live native-delegation test; consumes Codex and DeepSeek usage. |
| `deepcodex --version`, `deepcodex --help` | Print the package version or the command list. |

`run` executes a single ticket and consumes DeepSeek API usage. It takes an
exclusive per-user lock, so only one worker runs at a time. On Windows, cancellation
uses `taskkill /T`; descendants left behind after the Codex parent has already
exited cannot be reliably terminated.

## How it works

### Request routing

Codex talks to the router on loopback. The router authenticates each request
with a capability token generated at install time and stored with owner-only access,
then routes by model:

- requests for the child model (`deepseek-flash`) go to the DeepSeek Responses
  API with the DeepSeek key;
- requests for any other model in the configured catalog go to the native Codex
  backend with the client's own authentication headers, which are forwarded only
  there.

The DeepSeek key is never sent to the native backend, and native Codex
authentication is never sent to DeepSeek.

### Tool routing

Codex tool definitions, namespaces and history are adapted to what the DeepSeek
Responses API accepts, and the streaming response is transformed back into the
Codex collaboration shape. That adaptation is the vendored `codex-router` code
in `vendor/codex-router`, used under its MIT license.

### Encrypted handoff relay

Subagent tasks can travel from Codex as encrypted `agent_message` payloads that
the native backend can decode. For each uncached message the router makes a relay
call to the native model, asking it to return the exact plaintext and not to
answer the task itself, and then forwards that plaintext to DeepSeek. This is
why a delegated task consumes both Codex quota and DeepSeek API usage.

### Local data

The router writes bounded receipts to
`~/.config/deepcodex/desktop/receipts.jsonl`: routing decisions, model names,
tool names, task counts and token usage. Prompts, tool arguments and credentials
are not recorded. On errors, the receipt message has the DeepSeek key and the
capability token redacted.

## Tests

```sh
pnpm test
```

The default suite is offline: it uses fixtures and spends no provider usage. The
Codex transport test is skipped unless `DEEPCODEX_TEST_CODEX` points at a real
`codex` binary; when it is set, that test launches the real CLI against a local
fixture server. Treat it as an optional, deliberate opt-in rather than part of a
routine run. Windows command definitions and ACL handling have mocked tests; the
`.cmd` argument round trip, service supervisor and scheduled task stop tests run
only on Windows. Integration fixtures that require
POSIX shell scripts and process groups are skipped on Windows.

## Security notes

- The router listens only on `127.0.0.1` and rejects requests without the
  generated capability token.
- Credentials live in `~/.config/deepcodex/.env`, outside the repository, with
  owner-only access (`0700` directory and `0600` file on macOS/Linux; ACLs on Windows).
- Receipts and router state live in the private directory
  `~/.config/deepcodex/desktop`.
- Subagents inherit Codex permissions. A ticket's allowed files are instructions
  to the worker, not a filesystem sandbox.

## License

MIT; see [LICENSE](LICENSE). Vendored `codex-router` code retains its own
copyright notice and [MIT license](vendor/codex-router/LICENSE).
