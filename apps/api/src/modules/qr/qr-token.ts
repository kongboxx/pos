/**
 * The random part of a table's sticker URL.
 *
 * 12 bytes = 96 bits, written base64url so it is 16 characters and needs no
 * escaping in a URL. Short matters: every character is more dots in the printed
 * QR, and a denser code is one a cheap phone camera fails to read across a
 * table under dinner lighting.
 *
 * `randomBytes`, not `Math.random`: this is a credential printed in a public
 * room, and a predictable one would let anyone enumerate the shop's tables
 * without ever visiting.
 */

import { randomBytes } from 'node:crypto';

export function newQrToken(): string {
  return randomBytes(12).toString('base64url');
}
