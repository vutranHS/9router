import { spawnSync } from 'node:child_process';
import { mkdir, readFile, writeFile, rm, access } from 'node:fs/promises';
import path from 'node:path';

export const psQuote = value => "'" + String(value).replace(/'/g, "''") + "'";
export const encodePowerShell = script => Buffer.from(script, 'utf16le').toString('base64');
export const powershellArgs = script => ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encodePowerShell(script)];
export function powershell(script) {
  const result = spawnSync('powershell.exe', powershellArgs("$ErrorActionPreference='Stop'; [Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); " + script), { encoding: 'utf8', windowsHide: true });
  if (result.status !== 0) throw new Error(result.stderr?.trim() || result.error?.message || 'PowerShell failed');
  return result.stdout.trim();
}
export async function protectWindowsHome(home) {
  await mkdir(home, { recursive: true });
  powershell("$sid=[System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value; & icacls.exe " + psQuote(home) + " /inheritance:r /grant:r ('*'+$sid+':(OI)(CI)F') | Out-Null; if($LASTEXITCODE -ne 0){throw 'Cannot protect HUD configuration directory'}");
}
// Both Git Bash and PowerShell can invoke this command. No filesystem path is
// interpreted by the outer shell, including paths with spaces or apostrophes.
export function windowsStatusCommand(node, entry, id, home) {
  const script = "$env:NINE_ROUTER_HUD_HOME=" + psQuote(home) + "; [Console]::InputEncoding=[System.Text.UTF8Encoding]::new($false); [Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false); & " + psQuote(node) + ' ' + psQuote(entry) + ' status ' + psQuote(id) + '; exit $LASTEXITCODE';
  return 'powershell.exe ' + powershellArgs(script).join(' ');
}
export function windowsTerminalArgs({ node, entry, home, id, cwd }) {
  const command = mode => powershellArgs("$env:NINE_ROUTER_HUD_HOME=" + psQuote(home) + '; & ' + psQuote(node) + ' ' + psQuote(entry) + ' ' + mode + ' ' + psQuote(id) + '; exit $LASTEXITCODE');
  return ['-w', '9router-hud-' + id, 'new-tab', '--title', 'Codex · 9router HUD', '-d', cwd, 'powershell.exe', ...command('runner'), ';', 'split-pane', '-H', '--size', '0.18', '-d', cwd, 'powershell.exe', ...command('watch'), ';', 'move-focus', 'up'];
}

export async function windowsInvocation(binary, kind, args) {
  if (!/\.(cmd|bat|ps1)$/i.test(binary)) return { command: binary, args };
  // Launch official npm entry points directly: no cmd.exe reparsing of prompts,
  // JSON --settings, %, &, quotes or other user-controlled CLI arguments.
  const relative = kind === 'codex' ? ['@openai', 'codex', 'bin', 'codex.js'] : ['@anthropic-ai', 'claude-code', 'cli.js'];
  const entry = path.join(path.dirname(binary), 'node_modules', ...relative);
  try { await access(entry); } catch { throw new Error('Unsupported ' + kind + ' shell shim. Install the native CLI or its official npm package.'); }
  return { command: process.execPath, args: [entry, ...args] };
}
const marker = '9router-hud managed wrapper';
async function read(file) { try { return await readFile(file, 'utf8'); } catch (e) { if(e.code === 'ENOENT') return ''; throw e; } }

export async function installWindows({ home, entry, kinds, shell = powershell, protect = protectWindowsHome }) {
  const bin = path.join(home, 'bin');
  // cmd.exe expands these even inside quoted batch strings. Fail before edits.
  for (const value of [home, entry, process.execPath]) if (/[\r\n%!]/.test(value)) throw new Error('Windows wrapper installation requires paths without %, ! or newlines. Choose another NINE_ROUTER_HUD_HOME / npm prefix.');
  await protect(home);
  await mkdir(bin, { recursive: true });
  for (const kind of kinds) {
    const file = path.join(bin, kind + '.cmd');
    const old = await read(file);
    if (old && !old.includes(marker)) throw new Error('Refusing to replace unrelated file: ' + file);
  }
  const launcher = path.join(bin, 'launcher.cjs');
  const oldLauncher = await read(launcher);
  if (oldLauncher && !oldLauncher.includes(marker)) throw new Error('Refusing to replace unrelated file: ' + launcher);
  // Keep batch files ASCII; %~dp0 is resolved by cmd.exe without losing Unicode
  // usernames. JavaScript loads the actual package entry with its original path.
  await writeFile(launcher, '// ' + marker + '\nprocess.env.NINE_ROUTER_HUD_HOME=' + JSON.stringify(home) + ';\nimport(require("node:url").pathToFileURL(' + JSON.stringify(entry) + ').href);\n');
  for (const kind of kinds) {
    const body = '@echo off\r\nrem ' + marker + '\r\nsetlocal DisableDelayedExpansion\r\nnode.exe "%~dp0launcher.cjs" auto ' + kind + ' %*\r\nexit /b %errorlevel%\r\n';
    await writeFile(path.join(bin, kind + '.cmd'), body);
  }
  const envFile = path.join(home, 'cmd-path.cmd');
  const oldEnv = await read(envFile);
  if (oldEnv && !oldEnv.includes(marker)) throw new Error('Refusing to replace unrelated file: ' + envFile);
  await writeFile(envFile, '@rem ' + marker + '\r\n@set "PATH=%~dp0bin;%PATH%"\r\n');
  const metadataFile = path.join(home, 'windows-install.json');
  const previous = await read(metadataFile);
  const metadata = previous ? JSON.parse(previous) : null;
  // PowerShell profiles cover system-wide CLI installations (machine PATH comes
  // before user PATH). CMD AutoRun similarly prepends without replacing its existing command.
  const profiles = JSON.parse(shell("$d=[Environment]::GetFolderPath('MyDocuments'); @((Join-Path $d 'WindowsPowerShell\\profile.ps1'),(Join-Path $d 'PowerShell\\profile.ps1')) | ConvertTo-Json -Compress"));
  const hook = 'if exist "' + envFile + '" call "' + envFile + '"';
  // Write uninstall metadata before changing profiles or registry values, so a
  // partial installation remains removable.
  await writeFile(metadataFile, JSON.stringify({ profiles: [...new Set([...(metadata?.profiles || []), ...profiles])], hook, bin }));
  shell(`
$bin=${psQuote(bin)}; $envFile=${psQuote(envFile)}
$userPath=[Environment]::GetEnvironmentVariable('Path','User')
$parts=@($userPath -split ';' | Where-Object { $_ -and $_.TrimEnd('\\') -ine $bin.TrimEnd('\\') })
[Environment]::SetEnvironmentVariable('Path',(@($bin)+$parts -join ';'),'User')
$profiles=@(${profiles.map(psQuote).join(',')})
$begin='# >>> 9router-hud >>>'; $end='# <<< 9router-hud <<<'
foreach($profile in $profiles){
  $text=if(Test-Path -LiteralPath $profile){[IO.File]::ReadAllText($profile)}else{''}
  if($text.Contains($begin) -and !$text.Contains($end)){throw 'Incomplete HUD profile block'}
  $text=[regex]::Replace($text,'(?ms)^# >>> 9router-hud >>>\\r?\\n.*?^# <<< 9router-hud <<<\\r?\\n?','')
  $block=$begin+"\r\n"+'$env:Path = '+${psQuote(psQuote(bin + ';'))}+' + $env:Path'+"\r\n"+$end+"\r\n"
  [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($profile)) | Out-Null
  if($text -and !$text.EndsWith("\n")){$text+="\r\n"}
  [IO.File]::WriteAllText($profile,$text+$block,[Text.UTF8Encoding]::new($true))
}
$key='HKCU:\\Software\\Microsoft\\Command Processor'
if(!(Test-Path -LiteralPath $key)){New-Item -Path $key -Force | Out-Null}
$old=(Get-ItemProperty -Path $key -Name AutoRun -ErrorAction SilentlyContinue).AutoRun
$hook='if exist "'+$envFile+'" call "'+$envFile+'"'
$new=$old
if(!$old -or !$old.Contains($hook)){$new=if($old){$old+' & '+$hook}else{$hook}; Set-ItemProperty -Path $key -Name AutoRun -Value $new}
`);
  return { kinds, rc: 'Windows user PATH, PowerShell profiles and CMD AutoRun', bin };
}

export async function uninstallWindows(home, shell = powershell) {
  const file = path.join(home, 'windows-install.json');
  const raw = await read(file);
  if (raw) {
    const metadata = JSON.parse(raw);
    shell(`
$bin=${psQuote(metadata.bin)}
$userPath=[Environment]::GetEnvironmentVariable('Path','User')
$parts=@($userPath -split ';' | Where-Object { $_ -and $_.TrimEnd('\\') -ine $bin.TrimEnd('\\') })
[Environment]::SetEnvironmentVariable('Path',($parts -join ';'),'User')
foreach($profile in @(${metadata.profiles.map(psQuote).join(',')})){
 if(Test-Path -LiteralPath $profile){
  $text=[IO.File]::ReadAllText($profile)
  $text=[regex]::Replace($text,'(?ms)^# >>> 9router-hud >>>\\r?\\n.*?^# <<< 9router-hud <<<\\r?\\n?','')
  [IO.File]::WriteAllText($profile,$text,[Text.UTF8Encoding]::new($true))
 }
}
$key='HKCU:\\Software\\Microsoft\\Command Processor'
$old=(Get-ItemProperty -Path $key -Name AutoRun -ErrorAction SilentlyContinue).AutoRun
$hook=${psQuote(metadata.hook)}
if($old -eq $hook){Remove-ItemProperty -Path $key -Name AutoRun}
elseif($old -and $old.Contains(' & '+$hook)){Set-ItemProperty -Path $key -Name AutoRun -Value $old.Replace(' & '+$hook,'')}
`);
  }
  for (const name of ['bin/claude.cmd', 'bin/codex.cmd', 'bin/launcher.cjs', 'cmd-path.cmd']) {
    const owned = path.join(home, name);
    if ((await read(owned)).includes(marker)) await rm(owned);
  }
  await rm(file, { force: true });
}
