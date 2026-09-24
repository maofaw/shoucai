import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = new URL('../', import.meta.url);
fs.mkdirSync(new URL('web/engine/', root), { recursive: true });
for (const name of ['buy-window.mjs', 'market-history.mjs', 'recommend.mjs', 'weekend-prices.mjs']) {
  fs.copyFileSync(fileURLToPath(new URL(`src/${name}`, root)), fileURLToPath(new URL(`web/engine/${name}`, root)));
}
