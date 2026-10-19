import { stat } from "node:fs/promises";

import { invalidateFsScanCache } from "@oh-my-pi/pi-natives";

/** Refresh native directory discovery without invalidating single-file scans. */
export async function invalidateDirectoryScanCache(target: string): Promise<void> {
  if ((await stat(target)).isDirectory()) {
    invalidateFsScanCache(target);
  }
}
