import { createHash } from 'node:crypto';

export function etagOf(body: string | Buffer): string {
  return `"${createHash('sha1').update(body).digest('hex').slice(0, 16)}"`;
}
