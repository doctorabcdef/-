import { spawnSync } from 'node:child_process';
// Read the existing Git credential only into process memory. Never log it.
const credential = spawnSync('git', ['credential', 'fill'], {
  input: 'protocol=https\nhost=github.com\n\n', encoding: 'utf8',
  env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'Never' }, windowsHide: true,
});
const token = credential.stdout?.split(/\r?\n/).find(line => line.startsWith('password='))?.slice(9);
if (!token) { console.error('No existing GitHub credential is available.'); process.exit(1); }
const [method = 'GET', path = '/repos/doctorabcdef/-', body] = process.argv.slice(2);
if (!path.startsWith('/repos/doctorabcdef/-') && path !== '/user') throw new Error('Repository out of scope');
try {
  const result = await fetch(`https://api.github.com${path}`, {
    method, headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'yi-jian-deploy', ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body || undefined,
    signal: AbortSignal.timeout(30000),
  });
  const text = await result.text();
  console.log(JSON.stringify({ status: result.status, body: text ? JSON.parse(text) : null }));
  if (!result.ok) process.exitCode = 1;
} catch (error) { console.error(error.message); process.exitCode = 1; }
