import { mkdir, cp, writeFile, readFile } from 'node:fs/promises';
const root = '.cloud-workspace';
for (const dir of ['backend', 'src', 'db', '.openai']) await mkdir(`${root}/${dir}`, { recursive: true });
await cp('src/engine.js', `${root}/src/engine.js`);
await cp('backend/worker.js', `${root}/backend/worker.js`);
await cp('backend/chat.js', `${root}/backend/chat.js`);
await cp('backend/db/schema.ts', `${root}/db/schema.ts`);
await cp('backend/drizzle', `${root}/drizzle`, { recursive: true });
await writeFile(`${root}/package.json`, JSON.stringify({ name: 'yijian-cloud', private: true, type: 'module', scripts: { build: 'node build.mjs' } }, null, 2));
await writeFile(`${root}/.gitignore`, 'node_modules/\ndist/\n.sites-runtime/\n');
await writeFile(`${root}/build.mjs`, `import { mkdir, readFile, writeFile, cp } from 'node:fs/promises';
await mkdir('dist/server', { recursive: true });
const source = await readFile('backend/worker.js', 'utf8');
await writeFile('dist/server/index.js', source.replace("'../src/engine.js'", "'./engine.js'"));
await cp('src/engine.js', 'dist/server/engine.js');
await cp('backend/chat.js', 'dist/server/chat.js');
console.log('Cloud worker built.');
`);
let manifest;
try { manifest = JSON.parse(await readFile(`${root}/.openai/hosting.json`, 'utf8')); }
catch { manifest = JSON.parse(await readFile('backend/hosting.json', 'utf8')); }
manifest.d1 = 'DB';
await writeFile(`${root}/.openai/hosting.json`, JSON.stringify(manifest, null, 2) + '\n');
console.log('Cloud source and generated migrations prepared.');
