# hardlink-deduplication-scanner

Scans a directory tree for byte-identical regular files and replaces duplicate copies with hardlinks to the original, reclaiming disk space without changing file paths or contents.

## Usage

```js
import { scan, linkDuplicates } from 'hardlink-deduplication-scanner';

// scan returns groups of paths whose contents are byte-identical
const groups = await scan('/some/dir');
// groups is an array of string[] arrays, each containing paths to identical files

// linkDuplicates replaces all but the first path in each group with a hardlink
// to the first. Returns a summary of how many files were linked and bytes saved.
const result = await linkDuplicates(groups);
console.log(result);
```

## Why

Backups, package caches, and media libraries accumulate identical files across many directories. A deduplicating filesystem would handle this transparently, but on ext4/xfs/apfs the simplest way to reclaim the space is to hardlink the copies together: all paths still work, but the blocks are shared. The trade-off is that edits to one linked copy are visible through every other link (hardlinks share inodes), so this is only safe for genuinely read-only content. The library does not detect later mutation — that is the caller's responsibility.

## Edge cases

- Symlinks are never followed or linked; only regular files are candidates.
- Directories, sockets, and other special files are skipped.
- Files already hardlinked to each other (same device + inode) are treated as already deduplicated and skipped — the scanner will not try to link them again.
- The first path in each group (determined by the order of `fs.readdir`) is the survivor; its inode is kept and others are relinked to it. If you need deterministic ordering, sort the paths before calling `linkDuplicates`.
- Empty files are deduplicated too: they are identical by definition.
- `linkDuplicates` is not atomic across a group. If the process is killed mid-group, some links may be replaced and others not.

## Imports and exports

The package exports two async functions from the root:

- `scan(root: string): Promise<string[][]>` — returns groups of identical files.
- `linkDuplicates(groups: string[][]): Promise<LinkResult>` — hardlinks duplicates.

`LinkResult` has the shape `{ linked: number, bytesSaved: number, skipped: number }`.

## Performance

The window keeps a bounded buffer, so `push` is constant time and memory does not
grow with the length of the stream. `peak` and `trough` are linear in the window
size, which is the trade that keeps `push` cheap.

