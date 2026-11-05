const GB = 1024 ** 3;

/** "812 MB", "48.2 GB", "1.8 TB". */
export function diskSize(bytes: number): string {
  const gb = bytes / GB;
  if (gb >= 1024) return `${(gb / 1024).toFixed(1)} TB`;
  if (gb >= 1) return `${gb.toFixed(1)} GB`;
  return `${Math.round(bytes / 1024 ** 2)} MB`;
}

/**
 * The free space below which a disk is running low: 1 GB, or room for three more
 * backups like the newest (`backupBytes`), whichever is more.
 */
export function lowSpaceThreshold(backupBytes: number): number {
  return Math.max(GB, 3 * backupBytes);
}

/**
 * The free space documents may not take a disk below: room for the next backup like the newest
 * (`backupBytes`), and never under 200 MB. Lower than `lowSpaceThreshold`, which only warns.
 */
export function minimumFreeForUploads(backupBytes: number): number {
  return Math.max(200 * 1024 ** 2, backupBytes);
}
