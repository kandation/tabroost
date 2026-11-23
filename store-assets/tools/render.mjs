// Renders jobs with ONE throwaway headless Chrome via CDP, then kills it and deletes the profile.
// usage: node render.mjs jobs.json   jobs: [{url|html, w, h, out, transparent?:bool}]
import fs from 'node:fs'; import path from 'node:path'; import {spawn, execSync} from 'node:child_process';
import {pathToFileURL} from 'node:url';
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const SCRATCH = process.env.TABROOST_SCRATCH || (await import('node:os')).tmpdir();
const profile = path.join(SCRATCH, 'chrome-render-profile-' + process.pid);
const jobs = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const port = 9300 + Math.floor(Math.random() * 500);
const killMine = () => { try { execSync(`powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \\"Name='chrome.exe'\\" | Where-Object { $_.CommandLine -like '*${path.basename(profile)}*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }"`, {stdio: 'ignore'}); } catch {} };
const proc = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', '--disable-gpu', '--disable-extensions', '--disable-background-networking', '--allow-file-access-from-files', '--hide-scrollbars', 'about:blank'], {stdio: 'ignore', detached: false});
try {
  let ver; for (let i = 0; i < 60; i++) { try { ver = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json(); break; } catch { await new Promise(r => setTimeout(r, 250)); } }
  const page = ver.find(t => t.type === 'page');
  const ws = new WebSocket(page.webSocketDebuggerUrl); await new Promise(r => ws.onopen = r);
  let id = 0; const pend = new Map(); const evs = [];
  ws.onmessage = e => { const m = JSON.parse(e.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } else evs.push(m); };
  const send = (method, params = {}) => new Promise(r => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({id: i, method, params})); });
  await send('Page.enable');
  for (const j of jobs) {
    await send('Emulation.setDeviceMetricsOverride', {width: j.w, height: j.h, deviceScaleFactor: 1, mobile: false});
    await send('Emulation.setDefaultBackgroundColorOverride', {color: j.transparent === false ? {r: 255, g: 255, b: 255, a: 1} : {r: 0, g: 0, b: 0, a: 0}});
    let url = j.url;
    if (j.html) { const f = path.join(SCRATCH, 'job-' + Math.random().toString(36).slice(2) + '.html'); fs.writeFileSync(f, j.html); j._f = f; url = pathToFileURL(f).href; }
    evs.length = 0; await send('Page.navigate', {url});
    for (let i = 0; i < 80 && !evs.some(e => e.method === 'Page.loadEventFired'); i++) await new Promise(r => setTimeout(r, 50));
    await send('Runtime.evaluate', {expression: 'document.fonts.ready.then(()=>1)', awaitPromise: true});
    await new Promise(r => setTimeout(r, 80));
    const r = await send('Page.captureScreenshot', {format: 'png', clip: {x: 0, y: 0, width: j.w, height: j.h, scale: 1}, captureBeyondViewport: false});
    fs.mkdirSync(path.dirname(j.out), {recursive: true}); fs.writeFileSync(j.out, Buffer.from(r.result.data, 'base64'));
    if (j._f) fs.unlinkSync(j._f);
  }
  ws.close();
} finally {
  try { proc.kill(); } catch {} killMine();
  await new Promise(r => setTimeout(r, 800)); killMine();
  try { fs.rmSync(profile, {recursive: true, force: true, maxRetries: 5, retryDelay: 300}); } catch (e) { console.log('profile rm failed', e.message); }
  const left = execSync(`powershell -NoProfile -Command "(Get-CimInstance Win32_Process -Filter \\"Name='chrome.exe'\\" | Where-Object { $_.CommandLine -like '*${path.basename(profile)}*' } | Measure-Object).Count"`).toString().trim();
  console.log('my chrome processes remaining:', left, '| profile exists:', fs.existsSync(profile));
}
