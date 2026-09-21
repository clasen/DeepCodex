import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { privateWrite } from './private-files.js';

const literal = value => "'" + String(value).replaceAll("'", "''") + "'";
const unitValue = value => '"' + String(value).replaceAll('\\', '\\\\').replaceAll('"', '\\"')
  .replaceAll('%', '%%').replaceAll('\n', '\\n').replaceAll('\r', '\\r') + '"';

function run(command, args, spawn = spawnSync) {
  const result = spawn(command, args, { encoding: 'utf8', windowsHide: true });
  if (result.error || result.status !== 0) {
    throw new Error(`DeepCodex service command failed (${command}): ${result.error?.message || result.stderr?.trim() || `exit ${result.status}`}`);
  }
}

export function systemdUnit(state, env) {
  return '[Unit]\nDescription=DeepCodex router\n\n[Service]\nType=simple\n' +
    `ExecStart=:${unitValue(state.node)} ${unitValue(path.join(state.runtime, 'scripts/desktop.js'))} serve\n` +
    `WorkingDirectory=${unitValue(state.runtime)}\n` +
    `Environment=${unitValue('HOME=' + os.homedir())} ${unitValue('PATH=' + env.PATH)}\n` +
    `Restart=always\nRestartSec=${state.config.service_throttle_seconds}\nUMask=0077\n\n[Install]\nWantedBy=default.target\n`;
}

export function windowsServiceScript(action, state) {
  const name = '$name';
  const header = '$ErrorActionPreference = \'Stop\'\n' +
    `$name = ${literal(state.config.service_label + '-')} + [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value\n`;
  const existing = `$task = Get-ScheduledTask -TaskName ${name} -ErrorAction SilentlyContinue\n`;
  const stop = existing + `if ($task -and $task.State -eq 'Running') {\n  Stop-ScheduledTask -InputObject $task\n` +
    `  $deadline = (Get-Date).AddSeconds(${state.config.startup_timeout_seconds})\n` +
    `  while ((Get-ScheduledTask -TaskName ${name}).State -eq 'Running') {\n` +
    `    if ((Get-Date) -ge $deadline) { throw 'DeepCodex task did not stop' }\n    Start-Sleep -Seconds ${state.config.service_throttle_seconds}\n  }\n}\n`;
  if (action === 'stop') return header + stop;
  if (action === 'remove') return header + stop +
    `if ($task) { Unregister-ScheduledTask -TaskName ${name} -Confirm:$false }\n`;
  if (action !== 'install') throw new Error('Unknown service action');
  const argumentsText = `"${path.win32.join(state.runtime, 'scripts', 'desktop.js')}" serve`;
  const launcher = "$ErrorActionPreference = 'Stop'\n" +
    '$start = New-Object System.Diagnostics.ProcessStartInfo\n' +
    `$start.FileName = ${literal(state.node)}\n` +
    `$start.Arguments = ${literal(argumentsText)}\n` +
    `$start.WorkingDirectory = ${literal(state.runtime)}\n` +
    '$start.UseShellExecute = $false\n$start.CreateNoWindow = $true\n' +
    '$child = [System.Diagnostics.Process]::Start($start)\n' +
    '$child.WaitForExit()\nexit $child.ExitCode\n';
  const launcherArguments = '-NoProfile -NonInteractive -WindowStyle Hidden -EncodedCommand ' +
    Buffer.from(launcher, 'utf16le').toString('base64');
  return header + stop +
    `$user = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name\n` +
    `$action = New-ScheduledTaskAction -Execute (Join-Path $PSHOME 'powershell.exe') -Argument ${literal(launcherArguments)} -WorkingDirectory ${literal(state.runtime)}\n` +
    `$trigger = New-ScheduledTaskTrigger -AtLogOn -User $user\n` +
    `$principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited\n` +
    `$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -RestartCount ${state.config.windows_restart_count} -RestartInterval (New-TimeSpan -Seconds ${state.config.windows_restart_seconds})\n` +
    `Register-ScheduledTask -TaskName ${name} -Action $action -Trigger $trigger -Principal $principal -Settings $settings -Force | Out-Null\n` +
    `Start-ScheduledTask -TaskName ${name}\n`;
}

function powershellPath(env) {
  if (!env.SystemRoot) throw new Error('SystemRoot is required to manage the Windows service');
  return path.win32.join(env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}

export function userService(action, state, env = process.env, { platform = process.platform, spawn = spawnSync, home = os.homedir() } = {}) {
  if (platform === 'win32') {
    run(powershellPath(env), ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand',
      Buffer.from(windowsServiceScript(action, state), 'utf16le').toString('base64')], spawn);
    return;
  }
  if (platform !== 'linux') throw new Error(`Unsupported user service platform: ${platform}`);
  const unit = state.config.service_label + '.service';
  const filename = path.join(env.XDG_CONFIG_HOME || path.join(home, '.config'), 'systemd/user', unit);
  const systemctl = args => run('systemctl', ['--user', ...args], spawn);
  if (action === 'install') {
    fs.mkdirSync(path.dirname(filename), { recursive: true });
    privateWrite(filename, systemdUnit(state, env));
    systemctl(['daemon-reload']);
    systemctl(['stop', unit]);
    systemctl(['enable', '--now', unit]);
  } else if (action === 'stop' || action === 'remove') {
    systemctl(['disable', '--now', unit]);
    if (action === 'remove') {
      fs.rmSync(filename, { force: true });
      systemctl(['daemon-reload']);
    }
  } else throw new Error('Unknown service action');
}
