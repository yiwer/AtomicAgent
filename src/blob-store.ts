import { readBounded } from './bounded-file.js';
import { mkdir, lstat, open, unlink } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join, resolve } from 'node:path';

export interface BlobPort {
  write(id: string, bytes: Uint8Array): Promise<void>;
  read(id: string, maxBytes: number): Promise<Buffer>;
  remove(id: string): Promise<void>;
}
// Keys are platform UUIDs, never caller paths. Root belongs exclusively to the control process.
export class DiskBlobs implements BlobPort {
  private root: string;
  constructor(root: string) { this.root = resolve(root); }
  private async path(id: string) {
    if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error('invalid_blob_key');
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const root = await lstat(this.root);
    if (root.isSymbolicLink() || !root.isDirectory()) throw new Error('unsafe_blob_root');
    return join(this.root, id);
  }
  async write(id: string, bytes: Uint8Array) {
    const file = await open(await this.path(id), 'wx', 0o600);
    try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
  }
  async read(id: string, maxBytes: number) {
    const path = await this.path(id); const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.size > maxBytes) throw new Error('unsafe_blob');
    const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try { return await readBounded(file, maxBytes);
    } finally { await file.close(); }
  }
  async remove(id: string) {
    const path = await this.path(id);
    try { await unlink(path); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    try { await lstat(path); throw new Error('blob_still_present'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
}
