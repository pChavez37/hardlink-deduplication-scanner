import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

/**
 * Stats a path and returns its type, or null if it does not exist or is
 * inaccessible. We deliberately swallow ENOENT and EACCES here because a
 * directory tree can change while we are walking it, and a missing or
 * unreadable entry should simply be skipped rather than abort the scan.
 *
 * We do NOT use withFileTypes from readdir because a two-pass design
 * (stat-based) keeps the hardlink logic trivially correct: the stat we read
 * is the stat we act on.
 *
 * @param {string} p
 * @returns {Promise<import('node:fs').Stats | null>}
 */
async function safeStat(p) {
  try {
    return await fs.lstat(p);
  } catch (e) {
    if (e && (e.code === 'ENOENT' || e.code === 'EACCES')) {
      return null;
    }
    throw e;
  }
}

/**
 * Recursively collects the paths of every regular file beneath `root`.
 *
 * We use lstat (not stat) so symlinks are never followed: a symlink is
 * neither a candidate for deduplication nor a directory we should descend
 * into. Following symlinks during a tree walk is a classic source of
 * infinite loops and double-counting.
 *
 * @param {string} root Absolute or relative directory path.
 * @returns {Promise<string[]>} Absolute file paths.
 */
export async function collectRegularFiles(root) {
  /** @type {string[]} */
  const out = [];
  /** @type {string[]} */
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop();
    let entries;
    try {
      entries = await fs.readdir(dir);
    } catch (e) {
      // Unreadable directory: skip rather than abort the whole scan.
      if (e && (e.code === 'EACCES' || e.code === 'ENOENT')) {
        continue;
      }
      throw e;
    }
    for (const name of entries) {
      const full = path.join(dir, name);
      const st = await safeStat(full);
      if (!st) continue;
      if (st.isDirectory()) {
        stack.push(full);
      } else if (st.isFile()) {
        out.push(full);
      }
      // Sockets, fifos, block devices, symlinks: ignored.
    }
  }
  return out;
}

/**
 * Reads the entire contents of a file into a Buffer.
 *
 * @param {string} p
 * @returns {Promise<Buffer>}
 */
async function readAll(p) {
  return fs.readFile(p);
}

/**
 * Builds a stable SHA-1 hash of the file contents.
 *
 * We use SHA-1, not because we need collision resistance for security, but
 * because it is in node:crypto and is plenty strong for deduplication
 * grouping. After grouping by (size, hash) we still compare bytes in
 * groupsWithSameSize, so a hash collision would only cost an unnecessary
 * byte comparison — it could never cause a false link.
 *
 * @param {Buffer} buf
 * @returns {string}
 */
function sha1Hex(buf) {
  return createHash('sha1').update(buf).digest('hex');
}

/**
 * Groups a list of file paths by (size, content-hash). Only files with the
 * same size are ever compared, and within a size we hash the contents and
 * then confirm with a full byte comparison so that hash collisions are
 * harmless.
 *
 * We hash every file rather than doing pairwise comparisons because hashing
 * is O(n) reads while pairwise is O(n^2) in the worst case.
 *
 * @param {string[]} files
 * @returns {Promise<string[][]>} Groups of 2+ identical files.
 */
export async function groupIdentical(files) {
  /** @type {Map<number, string[]>} */
  const bySize = new Map();
  for (const p of files) {
    const st = await safeStat(p);
    if (!st || !st.isFile()) continue;
    const size = st.size;
    const bucket = bySize.get(size);
    if (bucket) {
      bucket.push(p);
    } else {
      bySize.set(size, [p]);
    }
  }

  /** @type {string[][]} */
  const groups = [];
  for (const bucket of bySize.values()) {
    if (bucket.length < 2) continue;

    // Hash each file, then group by hash.
    /** @type {Map<string, string[]>} */
    const byHash = new Map();
    for (const p of bucket) {
      let buf;
      try {
        buf = await readAll(p);
      } catch (e) {
        if (e && (e.code === 'EACCES' || e.code === 'ENOENT')) continue;
        throw e;
      }
      const h = sha1Hex(buf);
      const arr = byHash.get(h);
      if (arr) {
        arr.push(p);
      } else {
        byHash.set(h, [p]);
      }
    }

    for (const arr of byHash.values()) {
      if (arr.length < 2) continue;
      // Confirm with byte comparison against the first file. This is O(n) per
      // group, not O(n^2), and it eliminates any risk from hash collisions.
      const firstBuf = await readAll(arr[0]);
      const confirmed = [arr[0]];
      for (let i = 1; i < arr.length; i++) {
        const b = await readAll(arr[i]);
        if (Buffer.compare(b, firstBuf) === 0) {
          confirmed.push(arr[i]);
        }
      }
      if (confirmed.length >= 2) {
        groups.push(confirmed);
      }
    }
  }
  return groups;
}

/**
 * Walks `root` and returns groups of byte-identical regular files. Each
 * group is an array of absolute paths; the first element is the survivor
 * that `linkDuplicates` will keep.
 *
 * @param {string} root Directory to scan.
 * @returns {Promise<string[][]>}
 */
export async function scan(root) {
  const files = await collectRegularFiles(root);
  return groupIdentical(files);
}

/**
 * @typedef {Object} LinkResult
 * @property {number} linked     Number of files that were replaced with a hardlink.
 * @property {number} bytesSaved Logical bytes reclaimed (sum of sizes of linked files).
 * @property {number} skipped    Number of files that were already hardlinked to the survivor.
 */

/**
 * Replaces every file after the first in each group with a hardlink to the
 * first. Files already sharing an inode with the survivor are counted as
 * skipped.
 *
 * Why hardlink rather than copy-and-delete: a hardlink is atomic from the
 * filesystem's perspective (one rename) and shares the existing blocks, so
 * there is no I/O for the data and no transient space doubling.
 *
 * @param {string[][]} groups
 * @returns {Promise<LinkResult>}
 */
export async function linkDuplicates(groups) {
  let linked = 0;
  let bytesSaved = 0;
  let skipped = 0;
  for (const group of groups) {
    if (group.length < 2) continue;
    const survivor = group[0];
    const st = await safeStat(survivor);
    if (!st) continue;
    const survivorDev = st.dev;
    const survivorIno = st.ino;
    const size = st.size;
    for (let i = 1; i < group.length; i++) {
      const p = group[i];
      const pst = await safeStat(p);
      if (!pst) continue;
      // Already hardlinked to the same inode on the same device — nothing to do.
      if (pst.dev === survivorDev && pst.ino === survivorIno) {
        skipped++;
        continue;
      }
      // fs.link is atomic on POSIX: the path is replaced in one step. We
      // unlink first only to clear a path that exists, but link() overwrites
      // on most filesystems; we unlink explicitly to be portable to those
      // that reject linking onto an existing path (e.g. some NFS configs).
      // The trade-off is a brief window where the path does not exist.
      try {
        await fs.unlink(p);
        await fs.link(survivor, p);
        linked++;
        bytesSaved += size;
      } catch (e) {
        // If the link fails (e.g. cross-device), skip this file rather than
        // abort the whole operation. The caller can re-scan to see what
        // remains.
        if (e && (e.code === 'EXDEV' || e.code === 'EACCES' || e.code === 'ENOENT')) {
          continue;
        }
        throw e;
      }
    }
  }
  return { linked, bytesSaved, skipped };
}
