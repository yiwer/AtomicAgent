import type { FileHandle } from 'node:fs/promises';

// Caller owns path validation, no-follow opening and closing; shared code owns only bounded complete reads.
export async function readBounded(file: FileHandle, limit: number): Promise<Buffer> {
  const stat = await file.stat();
  if (!stat.isFile() || stat.size > limit) throw new Error('invalid_file_size');
  const bytes = Buffer.alloc(stat.size); let offset = 0;
  while (offset < bytes.length) {
    const { bytesRead } = await file.read(bytes, offset, bytes.length - offset, offset);
    if (!bytesRead) throw new Error('incomplete_file');
    offset += bytesRead;
  }
  if ((await file.stat()).size !== stat.size) throw new Error('file_changed');
  return bytes;
}
