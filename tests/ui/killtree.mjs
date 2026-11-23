// Shared test helper: stop a throw-away test Chrome COMPLETELY (main process, its whole tree, and any stray child whose
// command line mentions the profile dir), then delete the profile. Synchronous so it also works inside process.on('exit').
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
export function killChrome(chrome, profile) {
  try { if (chrome && chrome.pid) spawnSync('taskkill', ['/PID', String(chrome.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* ignore */ }
  try {
    const esc = String(profile).replace(/'/g, "''");
    spawnSync('powershell', ['-NoProfile', '-Command', `Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" | Where-Object { $_.CommandLine -like '*${esc}*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`], { stdio: 'ignore' });
  } catch { /* ignore */ }
  for (let i = 0; i < 8; i++) { try { fs.rmSync(profile, { recursive: true, force: true }); return; } catch { spawnSync('powershell', ['-NoProfile', '-Command', 'Start-Sleep -Milliseconds 500'], { stdio: 'ignore' }); } }
}
