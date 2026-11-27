import { readFile, rename, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { fetchRows, refresh } from '../lib/investmentValuation.mjs';

const output = new URL('../tools/investment-theory/valuations.json', import.meta.url);
async function main() {
  const text = await readFile(output, 'utf8').catch(error => {
    if (error.code !== 'ENOENT') throw error;
    return '';
  });
  const { next, warnings } = await refresh(text ? JSON.parse(text).indices : [], fetchRows);
  for (const warning of warnings) console.warn('::warning::' + warning);
  const payload = '{\n  "indices": [\n' + next.map(item => '    ' + JSON.stringify(item)).join(',\n') + '\n  ]\n}\n';
  if (payload !== text) {
    const temp = new URL(output.href + '.tmp');
    await writeFile(temp, payload);
    await rename(temp, output);
    console.log('Published valuation snapshot');
  } else {
    console.log('No changes');
  }
  console.log(next.map(item => item.code + ' ' + item.date + ' (' + item.history.length + ' days)').join(' / '));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
