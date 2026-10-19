import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('../web/index.html', import.meta.url), 'utf8');

test('overview keeps profits, harvest, weekly agenda and collapsed manufacturing in order', () => {
  const home = html.slice(html.indexOf('data-view="home"'), html.indexOf('data-view="plans"'));
  const positions = ['id="profitLowCard"', 'class="harvest-card"', 'class="weekly-agenda"', 'class="home-recipes"', 'id="buyShortcut"']
    .map(marker => home.indexOf(marker));
  assert.ok(positions.every(position => position >= 0));
  assert.deepEqual(positions, [...positions].sort((a, b) => a - b));
  assert.match(home, /<details class="home-recipes">/);
  assert.match(home, /id="homeBuyWindow"/);
  assert.match(home, /id="homeSellWindow"/);
});

test('buy list precedes optional opportunities and manual market refresh is removed', () => {
  assert.doesNotMatch(html, /id="refreshMarket"/);
  assert.ok(html.indexOf('id="buyList"') < html.indexOf('id="stableOpportunityList"'));
  assert.match(html, /<details class="opportunity-section"><summary id="stableOpportunityTitle"/);
  const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map(match => match[1]);
  assert.equal(new Set(ids).size, ids.length);
});

test('versioned entry assets are included in the offline shell', () => {
  const worker = readFileSync(new URL('../web/sw.js', import.meta.url), 'utf8');
  for (const match of html.matchAll(/(?:href|src)="\.\/(styles\.css|app\.js)\?v=(\d+)"/g)) {
    assert.ok(worker.includes(`./${match[1]}?v=${match[2]}`));
  }
});
