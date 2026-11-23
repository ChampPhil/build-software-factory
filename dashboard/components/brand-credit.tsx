import { BRAND, PRODUCTS } from "@/lib/brand";

/** "Built with Build Software Factory by Philip Valcin", plus the author's other products once there are any. */
export function BrandCredit() {
  return (
    <div className="brand-credit">
      Built with <a href={BRAND.url} target="_blank" rel="noopener noreferrer">{BRAND.name}</a> by {BRAND.author}
      {PRODUCTS.length > 0 && (
        <>
          {" "}· More from {BRAND.author}:{" "}
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
