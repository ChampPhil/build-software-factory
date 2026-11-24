/**
 * Who built the factory. One place, so a new product can be added later by
 * adding a line to `PRODUCTS`; the attribution everywhere else is built from it.
 * `dashboard/lib/brand.ts` repeats these values (the dashboard is a separate
 * package); `test/brand.test.ts` fails if the two drift apart.
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

/** The author's other products, shown beside the attribution. Empty for now. */
export const PRODUCTS: readonly { readonly name: string; readonly url: string }[] = [];

/** "Built with Build Your Software Factory by Philip Valcin", as Markdown. */
export function attributionMarkdown(): string {
  const base = `Built with [${BRAND.linkLabel}](${BRAND.url}) by ${BRAND.author}`;
  if (PRODUCTS.length === 0) return base;
  return `${base} · More from ${BRAND.author}: ${PRODUCTS.map((p) => `[${p.name}](${p.url})`).join(", ")}`;
}
