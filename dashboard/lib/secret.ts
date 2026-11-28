/**
 * Sealing the development environment for GitHub.
 *
 * Purpose:
 *     The settings screen reads an env file in the browser and seals it
 *     with GitHub's public key. The plain text is not sent to the factory
 *     and is not written into the page.
 *
 * Key terms:
 *     - Sealed box: libsodium's box that only GitHub's private key opens.
 *     - Public key: the key GitHub publishes for this repository's secrets.
 */

import { seal } from "tweetnacl-sealedbox-js";

/**
 * Seal an env file so it can be stored as FACTORY_SANDBOX_ENV.
 *
 * plain: the env file. It is not returned and must not be logged.
 * publicKey: the base64 key from GitHub.
 * Returns the sealed box as base64.
 */
export function sealEnv(plain: string, publicKey: string): string {
  const message = new TextEncoder().encode(plain);
  const key = Uint8Array.from(atob(publicKey), (c) => c.charCodeAt(0));
  const boxed = seal(message, key);
  let binary = "";
  for (const byte of boxed) binary += String.fromCharCode(byte);
  return btoa(binary);
}
