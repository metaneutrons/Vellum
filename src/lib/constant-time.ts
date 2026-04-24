/**
 * Constant-time string comparison.
 *
 * Hashes both values with SHA-256 first to produce fixed-length
 * buffers, preventing length-leaking via timingSafeEqual throws.
 */

import crypto from "crypto";

export function constantTimeEqual(a: string, b: string): boolean {
  const ha = crypto.createHash("sha256").update(a).digest();
  const hb = crypto.createHash("sha256").update(b).digest();
  return crypto.timingSafeEqual(ha, hb);
}
