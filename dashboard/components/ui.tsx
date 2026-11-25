"use client";

import type { ReactNode } from "react";
import { useEffect, useRef } from "react";
import { outcomeName, outcomeTone, statusName, toneOf } from "@/lib/view";

/**
 * The small shared pieces. Every look is a class in globals.css; nothing here
 * carries an inline style except a width that is data (a bar's fill).
 */

export function Mark() {
  return (
    <svg className="mark" viewBox="0 0 26 26" aria-hidden="true">
      <rect x="1" y="1" width="24" height="24" rx="7" fill="currentColor" />
      <path d="M10 8.2v9.6l7.6-4.8z" fill="var(--paper)" />
    </svg>
  );
}

export function Check() {
  return (
    <svg className="ic" width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
      <circle cx="8" cy="8" r="8" fill="var(--done)" />
      <path d="M4.5 8.2l2.2 2.2 4.8-4.8" stroke="var(--sheet)" strokeWidth="1.8" fill="none" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function Cross() {
  return (
    <svg className="ic" width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
      <circle cx="8" cy="8" r="8" fill="var(--stop)" />
      <path d="M5.5 5.5l5 5m0-5l-5 5" stroke="var(--sheet)" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  );
}

export function Pending() {
  return (
    <svg className="ic" width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
      <circle cx="8" cy="8" r="7" fill="none" stroke="var(--ink-3)" strokeWidth="2" strokeDasharray="3 3" />
    </svg>
  );
}

export const Spin = () => <span className="spinner" aria-hidden="true" />;

export function SearchIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
      <circle cx="7" cy="7" r="5" fill="none" stroke="currentColor" strokeWidth="1.6" />
      <path d="M11 11l3.5 3.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

export function Chev() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
      <path d="M3 4.5l3 3 3-3" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

function Ext() {
  return (
    <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
      <path d="M5 2H2v8h8V7M7 2h3v3M10 2L5.5 6.5" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
    </svg>
  );
}

export function PlayIcon() {
  return (
    <svg width="30" height="34" viewBox="0 0 30 34" aria-hidden="true">
      <path d="M2 2.5v29L28 17z" fill="#111" />
    </svg>
  );
}

/** A link that leaves the dashboard, marked as one. */
export function Out({ href, children }: { href: string; children: ReactNode }) {
  return (
    <a className="out" href={href} target="_blank" rel="noopener noreferrer">
      {children} <Ext />
    </a>
  );
}

export function Badge({ status }: { status: string }) {
  return <span className={`badge ${toneOf(status)}`}>{statusName(status)}</span>;
}

export function OutcomeBadge({ outcome }: { outcome: string }) {
  if (outcome === "running") {
    return (
      <span className="badge busy">
        <Spin />
        Running
      </span>
    );
  }
  return <span className={`badge ${outcomeTone(outcome)}`}>{outcomeName(outcome)}</span>;
}

/** "Attempt 2 of 3" as a counter running out. */
export function Tries({ attempt, of }: { attempt: number; of: number }) {
  return (
    <span className="tries" role="img" aria-label={`attempt ${attempt} of ${of}`}>
      {Array.from({ length: Math.max(of, attempt) }, (_, i) => (
        <i key={i} className={i < attempt - 1 ? "used" : i === attempt - 1 ? "now" : ""} />
      ))}
    </span>
  );
}

/** A filled bar with an optional line the fill must not cross. */
export function Bar({ fraction, mark, label, size }: { fraction: number; mark?: number; label: string; size?: "big" }) {
  const f = Math.max(0, Math.min(1, fraction));
  return (
    <div className={size === "big" ? "rail-bar big" : "rail-bar"} role="img" aria-label={label}>
      <i style={{ width: `${f * 100}%` }} />
      {mark !== undefined && <b style={{ left: `${Math.max(0, Math.min(1, mark)) * 100}%` }} />}
    </div>
  );
}

export function Loading({ what }: { what: string }) {
  return (
    <p className="loading" role="status">
      <Spin /> Reading {what}
    </p>
  );
}

/** A failure says what happened and offers the one thing that might fix it. */
export function Problem({ error, retry }: { error: string; retry?: () => void }) {
  return (
    <div className="callout stop" role="alert">
      <p>{error}</p>
      {retry !== undefined && (
        <div className="acts">
          <button className="btn small" type="button" onClick={retry}>
            Try again
          </button>
        </div>
      )}
    </div>
  );
}

/**
 * A modal. Escape and the scrim close it; focus moves into it on open and goes
 * back where it was on close, so a keyboard user is never left on a button
 * that no longer exists.
 */
export function Dialog({
  title,
  onClose,
  children,
  size,
  label,
}: {
  title?: string;
  onClose: () => void;
  children: ReactNode;
  size?: "small" | "sheet" | "pal" | "drawer";
  label?: string;
}) {
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const before = document.activeElement as HTMLElement | null;
    const target = box.current?.querySelector<HTMLElement>("[data-autofocus]") ?? box.current?.querySelector<HTMLElement>("input, textarea, select, button");
    target?.focus();
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      before?.focus?.();
    };
  }, [onClose]);
  return (
    <>
      <div className="scrim" onClick={onClose} aria-hidden="true" />
      <div ref={box} className={`dialog${size === undefined ? "" : ` ${size}`}`} role="dialog" aria-modal="true" aria-label={label ?? title}>
        {title !== undefined && <h2>{title}</h2>}
        {children}
      </div>
    </>
  );
}

/** Grows with what is typed, up to the CSS max-height. */
export function autoGrow(el: HTMLTextAreaElement | null): void {
  if (el === null) return;
  el.style.height = "auto";
  el.style.height = `${el.scrollHeight}px`;
}
