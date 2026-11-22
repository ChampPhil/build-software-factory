/**
 * Cloudflare Pages runs this for every request under /api/auth, on the
 * dashboard's own address. The logic is in worker/src/index.ts, where the
 * tests can reach it; this file only connects the two.
 *
 * Static pages never come here, so the site itself costs nothing to serve.
 * Only a sign-in or a token renewal does.
 */
import handler, { type Env } from "../../../worker/src/index";

export const onRequest = (context: { request: Request; env: Env }): Promise<Response> =>
  handler.fetch(context.request, context.env);
