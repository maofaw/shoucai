import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function showWindowsToast(title, body) {
  if (process.platform !== 'win32') return Promise.resolve(false);
  const script = path.join(projectRoot, 'scripts', 'toast.ps1');
  return new Promise(resolve => {
    const child = spawn('powershell.exe', [
      '-NoProfile',
      '-STA',
      '-ExecutionPolicy', 'Bypass',
      '-File', script,
      '-Title', title,
      '-Body', body
    ], { windowsHide: true, stdio: 'ignore' });
    child.once('error', () => resolve(false));
    child.once('exit', code => resolve(code === 0));
  });
}
