import { mkdir, cp, writeFile } from 'node:fs/promises';
await mkdir('dist/src', { recursive: true });
await cp('index.html', 'dist/index.html');
for (const file of ['app.js', 'engine.js', 'sync.js', 'http.js', 'poll.js', 'chat.js', 'chat.css', 'config.js', 'style.css']) await cp(`src/${file}`, `dist/src/${file}`);
await writeFile('dist/.nojekyll', '');
console.log('Built GitHub Pages website in dist/');
