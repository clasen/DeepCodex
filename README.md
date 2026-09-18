# DeepCodex

DeepCodex keeps the coordinator on your selected native Codex model and runs
DeepSeek Flash as an actual Codex subagent through a local loopback router. The
subagent appears in the normal collaboration tools (`spawn_agent`,
`followup_task`, `wait_agent`, `interrupt_agent`) under the model name
`deepseek-flash`. Nothing is disguised under an OpenAI model name, and the
native coordinator model is not replaced.

## Requirements

- macOS. The installer and the LaunchAgent service are macOS-only.
- Node.js >= 22.15. The worker uses `node:sqlite`, `fetch` and
  `import.meta.resolve`.
- A compatible Codex CLI, either on `PATH` or bundled with Codex Desktop.
  When no CLI is on `PATH`, DeepCodex checks `Codex.app` and `ChatGPT.app`
  under `~/Applications` and `/Applications`, in that order. No separate CLI
  installation is needed when Desktop includes a compatible binary.
  `codex exec` must support `--ignore-user-config`, `--ephemeral`, `--json`
  and `--strict-config`; `deepcodex doctor` verifies this before activation.
  A CLI on `PATH` takes priority, even if it is incompatible.
- A DeepSeek API key.

## Install globally

Once the package is published to npm:

```sh
npm install --global deepcodex
deepcodex configure
deepcodex doctor
deepcodex install
```

The global installation adds `deepcodex` to npm's global bin directory, which
must be on your `PATH`. Run it from any directory; no checkout path is needed.

To install the local checkout globally before publication, run these commands
from the repository, then use the same `deepcodex` commands above:

```sh
pnpm install --frozen-lockfile
npm install --global .
```

### Upgrading from OpenCodex

The npm package, command and plugin are now named `deepcodex`, and the service
is `com.deepcodex.router`. Existing private paths (`~/.config/opencodex`,
`~/.local/share/opencodex`) and provider IDs are retained, reusing your saved
key and backup.

Run `deepcodex doctor` and `deepcodex install` to refresh the runtime; there is
no need to run `configure` again if your key is already saved.

### 1. `deepcodex configure`

`configure` asks for the DeepSeek API key with hidden input on the terminal and
stores it in `~/.config/opencodex/.env`. It creates the directory with mode
`0700` and the file with mode `0600`, and it writes the key as plaintext in that
file rather than in the macOS keychain.

The command does not accept a key argument or piped input, keeping the key out
of shell history and process arguments. Press Ctrl-C to cancel without changing
the saved key. Re-running `configure` replaces the key while preserving other
variables in the file. Run `install` again to reload an already running router.

`config/worker.json` defines the credential file location. `doctor` and `run`
prefer `DEEPSEEK_API_KEY` from their environment when set; otherwise they read
the file, as does the installed desktop service. Credentials stay outside the
repository. The file permissions restrict other users, but programs running as
your user can still read it.

### 2. `deepcodex doctor`

`doctor` checks the local prerequisites without running inference: that a
compatible Codex CLI is reachable and that the DeepSeek credential is present.
Run it after `configure` and before `install`; `install` refuses to continue
unless the doctor reports `ready`.
Neither `configure` nor `doctor` contacts DeepSeek to validate the key. A `ready`
result confirms local prerequisites, not provider authentication or account credit.

### 3. `deepcodex install`

`install` activates the desktop integration:

- copies a stable runtime (scripts, config, prompts, vendor code and the bundled
  dependency) to `~/.local/share/opencodex/runtime`;
- writes private state, the model catalog and receipts to
  `~/.config/opencodex/desktop`;
- installs and starts the `com.deepcodex.router` LaunchAgent, bound only to
  `127.0.0.1:4207`;
- updates `~/.codex/config.toml` with the local provider, the subagent defaults
  and the generated model catalog, keeping a pre-install backup at
  `~/.config/opencodex/desktop/config.before.toml`;
- registers and installs the bundled DeepCodex plugin in the personal marketplace,
  including its current name, description, icon and delegation skill. An existing
  local OpenCodex plugin in that marketplace is replaced after DeepCodex installs;
- adds a marked DeepCodex block to the global `AGENTS.md` in `CODEX_HOME`
  (default `~/.codex`) when that block is absent. It asks Codex to consider
  delegation for suitable independent subtasks. Reinstallation preserves the
  existing block and all other instructions; uninstall removes only that block.

The installer refuses to run when an unrelated custom provider is active or when
an endpoint override is already configured, and it leaves your configuration
untouched if the service does not become healthy.

After `install`, fully quit and reopen Codex Desktop and start a new task. Tasks
that were already open keep the provider and model catalog they started with.

## Plugin skill

The delegation skill lives in `skills/delegate-flash/SKILL.md`. `deepcodex install`
copies the plugin to `~/plugins/deepcodex`, registers it in
`~/.agents/plugins/marketplace.json`, and installs it through the Codex CLI.
Repeating the command refreshes the plugin cache even when the package version
has not changed. Other personal marketplace entries are preserved.

## Commands

| Command | Purpose |
| --- | --- |
| `deepcodex configure` | Prompt for the DeepSeek API key and write `~/.config/opencodex/.env`. |
| `deepcodex doctor` | Check Codex CLI compatibility and credential presence without inference. |
| `deepcodex install` | Install the router runtime, LaunchAgent, Codex settings and current DeepCodex plugin. |
| `deepcodex uninstall` | Stop and remove the router, restoring the saved Codex configuration. Credentials are preserved. Refuses if config changed since installation. Restart Codex afterward; remove the npm package separately with `npm uninstall -g deepcodex`. |
| `deepcodex status` | Query the installed router health endpoint without inference. |
| `deepcodex run --cwd PATH --task-file PATH [--write]` | Run one bounded isolated worker ticket against DeepSeek. Read-only unless `--write` is given. |
| `deepcodex pilot` | Run the opt-in live native-delegation test; consumes Codex and DeepSeek usage. |
| `deepcodex --version`, `deepcodex --help` | Print the package version or the command list. |

`run` executes a single ticket and consumes DeepSeek API usage. It takes an
exclusive per-user lock, so only one worker runs at a time.

## How it works

### Request routing

Codex talks to the router on loopback. The router authenticates each request
with a capability token generated at install time and stored with mode `0600`,
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
`~/.config/opencodex/desktop/receipts.jsonl`: routing decisions, model names,
tool names, task counts and token usage. Prompts, tool arguments and credentials
are not recorded. On errors, the receipt message has the DeepSeek key and the
capability token redacted.

## Tests

```sh
pnpm test
```

The default suite is offline: it uses fixtures and spends no provider usage. The
Codex transport test is skipped unless `OPENCODEX_TEST_CODEX` points at a real
`codex` binary; when it is set, that test launches the real CLI against a local
fixture server. Treat it as an optional, deliberate opt-in rather than part of a
routine run.

## Security notes

- The router listens only on `127.0.0.1` and rejects requests without the
  generated capability token.
- Credentials live in `~/.config/opencodex/.env` (`0700` directory, `0600`
  file), outside the repository.
- Receipts and router state live in the private `0700` directory
  `~/.config/opencodex/desktop`.
- Subagents inherit Codex permissions. A ticket's allowed files are instructions
  to the worker, not a filesystem sandbox.

## License

MIT; see [LICENSE](LICENSE). Vendored `codex-router` code retains its own
copyright notice and [MIT license](vendor/codex-router/LICENSE).
