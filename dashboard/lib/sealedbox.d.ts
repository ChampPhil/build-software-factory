/** The sealed-box helper has no published types. seal is the only call this dashboard makes. */
declare module "tweetnacl-sealedbox-js" {
  export function seal(message: Uint8Array, publicKey: Uint8Array): Uint8Array;
}
