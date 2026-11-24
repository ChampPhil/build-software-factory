/**
 * Who built the factory. Add a product to `PRODUCTS` and it shows beside the
 * attribution in the footer. Mirrors `runner/src/lib/brand.ts`, which has the
 * test that keeps the two the same.
 */
export const BRAND = {
  name: "Build Software Factory",
  /**
   * The words the attribution link is made of.
   *
   * The product's name is a statement; a link wants to be an invitation, and
   * "Build Software Factory" as link text reads like the name of something
   * already happening rather than something the reader could do.
   */
  linkLabel: "Build Your Software Factory",
  author: "Philip Valcin",
  url: "https://github.com/ChampPhil/build-software-factory",
} as const;

export const PRODUCTS: readonly { readonly name: string; readonly url: string }[] = [];
