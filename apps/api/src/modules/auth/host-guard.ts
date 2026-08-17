/**
 * "This endpoint only exists on the till's domain."
 *
 * `/auth/staff` answers with every employee's name, nickname, role and id,
 * sorted with the owner first, to anyone who opens the URL. On the shop wifi
 * that was a list of colleagues on a device already inside the shop, and the
 * comment in auth.routes.ts said so. On the open internet it is the first half
 * of an attack: it hands over who the owner is and the staffId needed to start
 * guessing their PIN, in one unauthenticated request.
 *
 * WHAT THIS IS AND IS NOT. A Host header is chosen by whoever makes the
 * request. This is a real boundary only when the API cannot be reached
 * directly — when the reverse proxy is the sole way in and it matched the host
 * itself before proxying. Binding the API to localhost is plan 3's job, and
 * until that lands this narrows the target without sealing it. The per-IP
 * limiter on the login routes is the part that does not depend on the proxy.
 *
 * Refuses with 404, not 403: a 403 confirms the endpoint is there and that you
 * asked from the wrong place, which is more than a stranger needs to know.
 */

import type { FastifyReply, FastifyRequest } from 'fastify';

/**
 * An EMPTY list means "not configured", which means everything passes.
 *
 * That is the right default and it is worth being explicit about why, because
 * the safe-looking alternative is the broken one: treating empty as "nothing
 * matches" would 404 the till's own login screen in every dev environment and
 * in any deployment where the variable was not set — a shop that cannot open.
 */
export function isTillHost(hosts: readonly string[], header: string | undefined): boolean {
  if (hosts.length === 0) return true;
  if (!header) return false;

  // Exact match on the name, port stripped. Never endsWith: that would let
  // evil-shop.example.com through.
  const name = header.split(':')[0]?.toLowerCase() ?? '';
  return hosts.some((host) => host.toLowerCase() === name);
}

export function tillOnly(
  hosts: readonly string[],
): (request: FastifyRequest, reply: FastifyReply) => Promise<void> {
  return async (request, reply) => {
    if (isTillHost(hosts, request.headers.host)) return;

    await reply.status(404).send({
      error: 'NOT_FOUND',
      message: `ไม่พบเส้นทาง ${request.method} ${request.url}`,
    });
  };
}
