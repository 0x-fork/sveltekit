// simulates a deployment that edits the build output before the server starts
import fs from 'node:fs';

fs.writeFileSync('build/client/added-after-build.txt', 'added');
fs.writeFileSync('build/client/replaced-after-build.txt', 'replaced after build');
fs.rmSync('build/client/replaced-after-build.txt.gz', { force: true });
fs.rmSync('build/client/replaced-after-build.txt.br', { force: true });
