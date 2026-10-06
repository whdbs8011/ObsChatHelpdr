import { spawn } from 'node:child_process';
import { readFile, writeFile, mkdir, rename, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
function protect(mode, bytes) {
  return new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', fileURLToPath(new URL('./protect.ps1', import.meta.url)), '-Mode', mode], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', data => { output += data; });
    child.stderr.on('data', () => {});
    child.on('error', () => reject(new Error('Windows 로그인 정보 저장을 실행할 수 없습니다.')));
    child.on('close', code => code === 0 ? resolve(Buffer.from(output.trim(), 'base64')) : reject(new Error('저장된 로그인을 이 Windows 계정에서 읽을 수 없습니다.')));
    child.stdin.on('error', () => {}); child.stdin.end(bytes.toString('base64'));
  });
}
export function createDeviceStore(path) {
  return {
    async load() { try { return JSON.parse((await protect('Unprotect', await readFile(path))).toString('utf8')); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } },
    async save(data) { await mkdir(dirname(path), { recursive: true }); await writeFile(path + '.tmp', await protect('Protect', Buffer.from(JSON.stringify(data)))); await rename(path + '.tmp', path); },
    async clear() { await rm(path, { force: true }); }
  };
}
