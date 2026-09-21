import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { promisify } from 'node:util';

import { saveHistory, withHistoryLock } from './store.mjs';

const tempDirs = [];
const execFileAsync = promisify(execFile);

async function tempHistoryPath() {
  const directory = await mkdtemp(join(tmpdir(), 'dusd-monitor-store-'));
  tempDirs.push(directory);
  return join(directory, 'history.json');
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('saveHistory', () => {
  it('uses independent temp files for concurrent saves', async () => {
    const path = await tempHistoryPath();
    const histories = Array.from({ length: 20 }, (_, sequence) => ({ sequence }));

    await Promise.all(histories.map((history) => saveHistory(path, history)));

    const saved = JSON.parse(await readFile(path, 'utf8'));
    assert.ok(histories.some((history) => history.sequence === saved.sequence));
  });
});

describe('withHistoryLock', () => {
  it('serializes overlapping transactions in one process', async () => {
    const path = await tempHistoryPath();
    await writeFile(path, '0\n', 'utf8');

    await Promise.all(
      Array.from({ length: 10 }, () =>
        withHistoryLock(
          path,
          async () => {
            const value = Number(await readFile(path, 'utf8'));
            await new Promise((done) => setTimeout(done, 5));
            await writeFile(path, `${value + 1}\n`, 'utf8');
          },
          { retryMs: 1, timeoutMs: 5_000 },
        ),
      ),
    );

    assert.equal(await readFile(path, 'utf8'), '10\n');
    await assert.rejects(readFile(`${path}.lock`, 'utf8'), { code: 'ENOENT' });
  });

  it('serializes history transactions across processes', async () => {
    const path = await tempHistoryPath();
    await writeFile(path, '0\n', 'utf8');
    const storeUrl = new URL('./store.mjs', import.meta.url).href;
    const increment = `
      import { readFile, writeFile } from 'node:fs/promises';
      import { withHistoryLock } from ${JSON.stringify(storeUrl)};
      const path = process.argv[1];
      await withHistoryLock(path, async () => {
        const value = Number(await readFile(path, 'utf8'));
        await new Promise((done) => setTimeout(done, 10));
        await writeFile(path, \`${'${value + 1}'}\\n\`, 'utf8');
      }, { retryMs: 2, timeoutMs: 5_000 });
    `;

    await Promise.all(
      Array.from({ length: 6 }, () =>
        execFileAsync(process.execPath, ['--input-type=module', '--eval', increment, path]),
      ),
    );

    assert.equal(await readFile(path, 'utf8'), '6\n');
    await assert.rejects(readFile(`${path}.lock`, 'utf8'), { code: 'ENOENT' });
  });

  it('recovers a lock left by a terminated process', async () => {
    const path = await tempHistoryPath();
    await writeFile(
      `${path}.lock`,
      `${JSON.stringify({ pid: 2_147_483_647, token: 'abandoned' })}\n`,
      'utf8',
    );

    const result = await withHistoryLock(path, async () => 'acquired', {
      retryMs: 1,
      timeoutMs: 1_000,
    });

    assert.equal(result, 'acquired');
    await assert.rejects(readFile(`${path}.lock`, 'utf8'), { code: 'ENOENT' });
  });
});
