import { BRAND, PRODUCTS } from "@/lib/brand";

/**
 * "Built with Build Your Software Factory by Philip Valcin", plus the
 * author's other products once there are any.
 *
 * The link text is `linkLabel`, not `name`: the product's name is a
 * statement and a link wants to be an invitation. This component renders its
 * own JSX rather than going through `attributionMarkdown`, which is how it
 * drifted from the Markdown the factory writes into pull requests.
 */
export function BrandCredit() {
  return (
    <div className="brand-credit">
      Built with <a href={BRAND.url} target="_blank" rel="noopener noreferrer">{BRAND.linkLabel}</a> by {BRAND.author}
      {PRODUCTS.length > 0 && (
        <>
          {" "}More from {BRAND.author}:{" "}
          {PRODUCTS.map((p, i) => (
            <span key={p.url}>
              {i > 0 && ", "}
              <a href={p.url} target="_blank" rel="noopener noreferrer">{p.name}</a>
            </span>
          ))}
        </>
      )}
    </div>
  );
}
