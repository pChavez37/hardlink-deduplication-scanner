import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { scan, linkDuplicates } from '../src/core.js';

/**
 * Creates a temporary directory and returns its path. The caller is
 * responsible for cleanup.
 * @returns {Promise<string>}
 */
async function tmpDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'hds-'));
}

/**
 * Writes a file with the given contents, creating parent directories as
 * needed.
 * @param {string} root
 * @param {string} rel
 * @param {string|Buffer} contents
 */
async function writeFile(root, rel, contents) {
  const full = path.join(root, rel);
  await fs.mkdir(path.dirname(full), { recursive: true });
  await fs.writeFile(full, contents);
}

/**
 * Returns the inode and device for a path.
 * @param {string} p
 */
async function inodeOf(p) {
  const st = await fs.stat(p);
  return { dev: st.dev, ino: st.ino };
}

test('scan finds identical files in separate directories', async () => {
  const root = await tmpDir();
  try {
    await writeFile(root, 'a/x.txt', 'hello world');
    await writeFile(root, 'b/y.txt', 'hello world');
    await writeFile(root, 'c/z.txt', 'different');
    const groups = await scan(root);
    assert.equal(groups.length, 1);
    assert.equal(groups[0].length, 2);
    // Both identical files should appear; the unique one should not.
    const set = new Set(groups[0].map((p) => path.basename(p)));
    assert.ok(set.has('x.txt'));
    assert.ok(set.has('y.txt'));
    assert.ok(!set.has('z.txt'));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('scan returns empty array when there are no duplicates', async () => {
  const root = await tmpDir();
  try {
    await writeFile(root, 'a.txt', 'aaa');
    await writeFile(root, 'b.txt', 'bbb');
    await writeFile(root, 'c.txt', 'ccc');
    const groups = await scan(root);
    assert.deepEqual(groups, []);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('scan groups files by content, not name', async () => {
  const root = await tmpDir();
  try {
    await writeFile(root, 'readme.md', 'same');
    await writeFile(root, 'config.json', 'same');
    await writeFile(root, 'index.html', 'same');
    const groups = await scan(root);
    assert.equal(groups.length, 1);
    assert.equal(groups[0].length, 3);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('scan distinguishes files of different content but same size', async () => {
  const root = await tmpDir();
  try {
    await writeFile(root, 'a.txt', 'aaaa');
    await writeFile(root, 'b.txt', 'bbbb');
    const groups = await scan(root);
    assert.deepEqual(groups, []);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('scan does not follow symlinks', async () => {
  const root = await tmpDir();
  try {
    await writeFile(root, 'real.txt', 'data');
    // Create a symlink pointing at the real file.
    await fs.symlink(path.join(root, 'real.txt'), path.join(root, 'link.txt'));
    const groups = await scan(root);
    // The symlink is not a regular file, so only real.txt is a candidate —
    // no group of 2+ can exist.
    assert.deepEqual(groups, []);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('scan ignores directories and special files', async () => {
  const root = await tmpDir();
  try {
    await writeFile(root, 'sub/a.txt', 'x');
    await writeFile(root, 'sub/b.txt', 'x');
    const groups = await scan(root);
    assert.equal(groups.length, 1);
    assert.equal(groups[0].length, 2);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('scan deduplicates empty files', async () => {
  const root = await tmpDir();
  try {
    await writeFile(root, 'a.txt', '');
    await writeFile(root, 'b.txt', '');
    await writeFile(root, 'c.txt', '');
    const groups = await scan(root);
    assert.equal(groups.length, 1);
    assert.equal(groups[0].length, 3);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('scan handles nested duplicates across many directories', async () => {
  const root = await tmpDir();
  try {
    const payload = 'nested payload';
    await writeFile(root, 'd1/d2/a.txt', payload);
    await writeFile(root, 'd1/d3/b.txt', payload);
    await writeFile(root, 'd4/c.txt', payload);
    await writeFile(root, 'd4/d.txt', 'unique');
    const groups = await scan(root);
    assert.equal(groups.length, 1);
    assert.equal(groups[0].length, 3);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('linkDuplicates replaces copies with hardlinks to the survivor', async () => {
  const root = await tmpDir();
  try {
    await writeFile(root, 'a.txt', 'hardlink me');
    await writeFile(root, 'b.txt', 'hardlink me');
    await writeFile(root, 'c.txt', 'hardlink me');
    const groups = await scan(root);
    const result = await linkDuplicates(groups);
    assert.equal(result.linked, 2);
    assert.equal(result.skipped, 0);
    // All three should now share the same inode.
    const ia = await inodeOf(path.join(root, 'a.txt'));
    const ib = await inodeOf(path.join(root, 'b.txt'));
    const ic = await inodeOf(path.join(root, 'c.txt'));
    assert.deepEqual(ib, ia);
    assert.deepEqual(ic, ia);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('linkDuplicates reports bytes saved based on file size', async () => {
  const root = await tmpDir();
  try {
    const content = '0123456789'; // 10 bytes
    await writeFile(root, 'a.txt', content);
    await writeFile(root, 'b.txt', content);
    const groups = await scan(root);
    const result = await linkDuplicates(groups);
    assert.equal(result.linked, 1);
    assert.equal(result.bytesSaved, 10);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('linkDuplicates skips files already hardlinked to the survivor', async () => {
  const root = await tmpDir();
  try {
    await writeFile(root, 'a.txt', 'already linked');
    // Pre-create a hardlink so a.txt and b.txt share an inode.
    await fs.link(path.join(root, 'a.txt'), path.join(root, 'b.txt'));
    const groups = await scan(root);
    // scan still reports them as identical.
    assert.equal(groups.length, 1);
    assert.equal(groups[0].length, 2);
    const result = await linkDuplicates(groups);
    // b.txt is already linked, so nothing is linked and one is skipped.
    assert.equal(result.linked, 0);
    assert.equal(result.skipped, 1);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('linkDuplicates handles multiple groups independently', async () => {
  const root = await tmpDir();
  try {
    await writeFile(root, 'g1/a.txt', 'group one');
    await writeFile(root, 'g1/b.txt', 'group one');
    await writeFile(root, 'g2/a.txt', 'group two');
    await writeFile(root, 'g2/b.txt', 'group two');
    await writeFile(root, 'g2/c.txt', 'group two');
    const groups = await scan(root);
    assert.equal(groups.length, 2);
    const result = await linkDuplicates(groups);
    assert.equal(result.linked, 3); // 1 from g1, 2 from g2
    // Verify all of g2 shares an inode.
    const inos = await Promise.all([
      inodeOf(path.join(root, 'g2/a.txt')),
      inodeOf(path.join(root, 'g2/b.txt')),
      inodeOf(path.join(root, 'g2/c.txt')),
    ]);
    assert.deepEqual(inos[1], inos[0]);
    assert.deepEqual(inos[2], inos[0]);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test('linkDuplicates with empty groups returns zero result', async () => {
  const result = await linkDuplicates([]);
  assert.deepEqual(result, { linked: 0, bytesSaved: 0, skipped: 0 });
});

test('linkDuplicates preserves file contents after linking', async () => {
  const root = await tmpDir();
  try {
    const content = 'preserve me';
    await writeFile(root, 'a.txt', content);
    await writeFile(root, 'b.txt', content);
    const groups = await scan(root);
    await linkDuplicates(groups);
    const a = await fs.readFile(path.join(root, 'a.txt'), 'utf8');
    const b = await fs.readFile(path.join(root, 'b.txt'), 'utf8');
    assert.equal(a, content);
    assert.equal(b, content);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
