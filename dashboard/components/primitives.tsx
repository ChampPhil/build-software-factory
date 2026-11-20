import type { ReactNode } from "react";
import { formatPct, formatUsd, formatDuration, type Measure } from "@/lib/metrics";
import type { Pipeline } from "@/lib/types";

/**
 * The shared pieces. Two of them carry the dashboard's point of view:
 * `Gauge`, because every limit in this product moves one way only and a bare
 * percentage hides that, and `Pips`, because "attempt 2 of 3" is a counter
 * running out rather than a sentence.
 */

/** A headline figure. An unknown value says why, instead of showing zero. */
export function Figure({
  label, value, sub, format,
}: {
  label: string;
  value: Measure;
  sub?: string | undefined;
  format: (n: number) => string;
}) {
  return (
    <div className="figure">
      <dt>{label}</dt>
      {value.known ? (
        <>
          <dd>{format(value.value)}</dd>
          {sub !== undefined && <div className="sub">{sub}</div>}
        </>
      ) : (
        <dd className="absent">{value.why}</dd>
      )}
    </div>
  );
}

export const asPct = (n: number): string => formatPct(n);
export const asPct1 = (n: number): string => formatPct(n, 1);
export const asUsd = (n: number): string => formatUsd(n);
export const asDuration = (n: number): string => formatDuration(n);
export const asCount = (n: number): string => n.toLocaleString("en-US");
/** One decimal place, for an average of small counts. */
export const asDecimal = (n: number): string =>
  n.toLocaleString("en-US", { minimumFractionDigits: 1, maximumFractionDigits: 1 });

/**
 * A track with a fill and, where one exists, a marked line the fill must not
 * fall below. Used for coverage against its floor, cleanup against its
 * starting count, and a budget share against its allowance.
 */
export function Gauge({
  name, read, fraction, markAt, markLabel, foot, tone = "pass",
}: {
  name: string;
  read: string;
  fraction: number;
  markAt?: number | undefined;
  markLabel?: string | undefined;
  foot?: string | undefined;
  tone?: "pass" | "run" | "fail" | undefined;
}) {
  const pct = Math.max(0, Math.min(1, fraction)) * 100;
  return (
    <div className="gauge">
      <div className="gauge-head">
        <span className="name">{name}</span>
        <span className="read">{read}</span>
      </div>
      <div
        className="gauge-track"
        role="meter"
        aria-label={name}
        aria-valuenow={Math.round(pct)}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuetext={read}
      >
        <div className={`gauge-fill ${tone}`} style={{ width: `${pct}%` }} />
        {markAt !== undefined && (
          <div
            className="gauge-mark"
            style={{ left: `${Math.max(0, Math.min(100, markAt * 100))}%` }}
            {...(markLabel === undefined ? {} : { "data-label": markLabel })}
          />
        )}
      </div>
      {foot !== undefined && <div className="gauge-foot">{foot}</div>}
    </div>
  );
}

/** Attempt slots: used, current, remaining. Failed attempts show as failed. */
export function Pips({ attempt, of, failed = 0 }: { attempt: number; of: number; failed?: number }) {
  const slots = Array.from({ length: Math.max(of, attempt) }, (_, i) => i + 1);
  return (
    <span className="pips" role="img" aria-label={`attempt ${attempt} of ${of}`}>
      {slots.map((n) => (
        <span
          key={n}
          className={
            n < attempt
              ? n <= failed
                ? "pip failed"
                : "pip used"
              : n === attempt
                ? "pip current"
                : "pip"
          }
        />
      ))}
    </span>
  );
}

const PIPELINE_LABEL: Readonly<Record<Pipeline, string>> = {
  product_work: "product",
  gardening: "gardening",
  hardening: "hardening",
  definition: "definition",
  conflict: "conflict",
};

export function PipelineTag({ pipeline }: { pipeline: Pipeline }) {
  return <span className={`tag ${pipeline}`}>{PIPELINE_LABEL[pipeline] ?? pipeline}</span>;
}

export function Dot({
  tone, title,
}: {
  tone: "pass" | "fail" | "run" | "idle" | "define";
  title?: string | undefined;
}) {
  return <span className={`dot ${tone}`} {...(title === undefined ? {} : { title })} aria-hidden="true" />;
}

export function PageHead({
  title, lede, actions,
}: {
  title: string;
  lede?: string | undefined;
  actions?: ReactNode | undefined;
}) {
  return (
    <header className="page-head">
      <div>
        <h1>{title}</h1>
        {lede !== undefined && <p>{lede}</p>}
      </div>
      {actions !== undefined && <div className="actions">{actions}</div>}
    </header>
  );
}

export function Section({
  title, lede, children,
}: {
  title: string;
  lede?: string | undefined;
  children: ReactNode;
}) {
  return (
    <section className="section">
      <h2>{title}</h2>
      {lede !== undefined && <p className="lede">{lede}</p>}
      {children}
    </section>
  );
}

/** An empty state is an instruction, not an apology. */
export function Empty({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="empty">
      <h3>{title}</h3>
      <p>{children}</p>
    </div>
  );
}

export function Note({ tone = "info", children }: { tone?: "info" | "quiet" | "bad"; children: ReactNode }) {
  const cls = tone === "info" ? "note" : tone === "quiet" ? "note quiet" : "note bad";
  return <div className={cls}>{children}</div>;
}

/** A small bar chart. No axes: it is a shape, and the numbers are in the list. */
export function Bars({ values, highlightLast = true }: { values: readonly number[]; highlightLast?: boolean }) {
  const max = Math.max(1, ...values);
  return (
    <div className="bars" role="img" aria-label={`${values.length} day trend`}>
      {values.map((v, i) => (
        <div
          key={i}
          className={highlightLast && i === values.length - 1 ? "hi" : undefined}
          style={{ height: `${(v / max) * 100}%` }}
          title={String(v)}
        />
      ))}
    </div>
  );
}
