import { mkdir, cp, readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
const root = resolve('.cloud-workspace');
const stage = resolve('.artifacts', `cloud-package-${Date.now()}`);
const manifest = JSON.parse(await readFile(`${root}/.openai/hosting.json`, 'utf8'));
if (manifest.d1 !== 'DB' || !manifest.project_id) throw new Error('Invalid cloud manifest');
await mkdir(`${stage}/dist/.openai`, { recursive: true });
await cp(`${root}/dist/server`, `${stage}/dist/server`, { recursive: true });
await cp(`${root}/.openai/hosting.json`, `${stage}/dist/.openai/hosting.json`);
await cp(`${root}/drizzle`, `${stage}/dist/.openai/drizzle`, { recursive: true });
const archive = resolve('.artifacts/cloud.tar.gz');
const packed = spawnSync('tar.exe', ['-czf', archive, '-C', stage, 'dist'], { encoding: 'utf8', windowsHide: true });
if (packed.status !== 0) throw new Error(packed.stderr || 'Archive creation failed');
const listing = spawnSync('tar.exe', ['-tzf', archive], { encoding: 'utf8', windowsHide: true });
for (const required of ['dist/server/index.js', 'dist/server/engine.js', 'dist/.openai/hosting.json', 'dist/.openai/drizzle/']) {
  if (!listing.stdout.includes(required)) throw new Error(`Missing archive member: ${required}`);
}
const commit = spawnSync('git', ['-C', root, 'rev-parse', 'HEAD'], { encoding: 'utf8', windowsHide: true }).stdout.trim();
console.log(JSON.stringify({ project_id: manifest.project_id, checkout_path: root, commit_sha: commit, archive }));
