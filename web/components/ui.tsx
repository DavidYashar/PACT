"use client";

import type { ReactNode } from "react";
import Link from "next/link";
import { formatUsd, formatWif } from "@/lib/format";

/// The console slab: title left, one-line note right, content below. Every screen's primary
/// object sits in one, and nothing floats on a shadow.
export function Panel({ children, className = "" }: { children: ReactNode; className?: string }) {
  return (
    <div className={`panel-sheen rounded-[16px] border border-line bg-panel ${className}`}>{children}</div>
  );
}

export function PanelHeader({
  title,
  note,
  action,
  className = "",
}: {
  title: ReactNode;
  note?: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  /// Title and action share the first line; the note goes under it. Side by side, a long note
  /// pushes the action into the middle of the row on a phone, which reads as a mistake.
  return (
    <div className={`border-b border-line px-5 py-4 ${className}`}>
      <div className="flex items-baseline justify-between gap-4">
        <h2 className="text-[13px] font-medium text-text">{title}</h2>
        {action ? <div className="shrink-0">{action}</div> : null}
      </div>
      {note ? <p className="mt-1.5 max-w-xl text-[11px] leading-relaxed text-muted">{note}</p> : null}
    </div>
  );
}

/// A numbered section. The number is not decoration: it is the order things actually happen in,
/// so a reader can say "I am on step two of four". Modelled on the reference's numbered slabs.
export function Section({
  n,
  title,
  note,
  action,
  children,
  className = "",
}: {
  n: string;
  title: string;
  note?: ReactNode;
  action?: ReactNode;
  children?: ReactNode;
  className?: string;
}) {
  return (
    <section className={className}>
      <div className="mb-5 flex flex-wrap items-end justify-between gap-4">
        <div>
          <div className="mb-2 flex items-center gap-2.5">
            <span className="mono flex h-6 w-6 items-center justify-center rounded-full border border-line-2 text-[10px] tabular-nums text-muted">
              {n}
            </span>
            <span className="label">{title}</span>
          </div>
          {note ? <p className="display max-w-2xl text-[22px] text-text sm:text-[26px]">{note}</p> : null}
        </div>
        {action ? <div className="shrink-0">{action}</div> : null}
      </div>
      {children}
    </section>
  );
}

/// The tall slab the reference builds whole sections around: a number, a title, one paragraph,
/// generous padding, and a lit top edge. Content decides the height; nothing is a fixed card.
export function Slab({
  n,
  title,
  children,
  className = "",
}: {
  n?: string;
  title?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={`panel-sheen flex flex-col gap-4 rounded-[16px] border border-line bg-panel p-6 sm:p-8 ${className}`}>
      {n || title ? (
        <div className="flex items-baseline gap-3">
          {n ? <span className="display text-[26px] text-muted">{n}</span> : null}
          {title ? <span className="label text-text">{title}</span> : null}
        </div>
      ) : null}
      {children}
    </div>
  );
}

/// A micro-label names a state or a field. It is not a section eyebrow: a page does not get to
/// restate its own heading in a badge above itself.
export function SectionLabel({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <div className={`label ${className}`}>{children}</div>;
}

/// The job states its own position, using the contract's own state numbers so the sequence
/// cannot drift from the enum.
export function StateSteps({ steps, current }: { steps: string[]; current: number }) {
  return (
    <ol className="flex flex-wrap items-center gap-x-3 gap-y-1">
      {steps.map((step, index) => {
        const n = index + 1;
        const active = n === current;
        const past = n < current;
        return (
          <li key={step} className="flex items-center gap-2">
            <span
              className={`mono text-[10px] tabular-nums ${active ? "text-accent" : past ? "text-muted" : "text-muted/50"}`}
            >
              {String(n).padStart(2, "0")}
            </span>
            <span
              className={`label ${active ? "text-text" : past ? "text-muted" : "text-muted/50"}`}
              aria-current={active ? "step" : undefined}
            >
              {step}
            </span>
          </li>
        );
      })}
    </ol>
  );
}

/// WIF and USD, together, always tabular. The rate is a display convenience, never a claim.
export function Money({
  value,
  unit = "WIF",
  size = "md",
  className = "",
}: {
  value: bigint | undefined;
  unit?: "WIF" | "USD";
  size?: "sm" | "md" | "lg" | "xl";
  className?: string;
}) {
  const scale = {
    sm: "text-[12px]",
    md: "text-[15px]",
    lg: "text-[22px]",
    xl: "text-[30px]",
  }[size];
  return (
    <span className={`mono tabular-nums text-text ${scale} ${className}`}>
      {unit === "WIF" ? (
        <>
          {formatWif(value)} <span className="text-muted">WIF</span>
        </>
      ) : (
        <span className="text-muted">{formatUsd(value)}</span>
      )}
    </span>
  );
}

export function Stat({
  label,
  value,
  sub,
  accent,
}: {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  accent?: boolean;
}) {
  return (
    <div className="flex flex-col gap-1.5 border-line px-5 py-5 [&:not(:last-child)]:border-r max-sm:border-b max-sm:[&:not(:last-child)]:border-r-0">
      <SectionLabel>{label}</SectionLabel>
      <div className={`mono text-2xl leading-none tabular-nums ${accent ? "text-accent" : "text-text"}`}>{value}</div>
      {sub ? <div className="mono text-[11px] text-muted">{sub}</div> : null}
    </div>
  );
}

const STATE_STYLE: Record<number, string> = {
  0: "text-muted border-line-2",
  1: "text-accent border-accent/40 bg-accent/5",
  2: "text-text border-line-2 bg-panel-2",
  3: "text-warn border-warn/40 bg-warn/5",
  4: "text-danger border-danger/40 bg-danger/5",
  5: "text-text border-line-2 bg-panel-2",
  6: "text-muted border-line-2",
};

/// Status is the one place a pill is allowed, and it always carries a word as well as a colour.
export function StateBadge({ state, label }: { state: number; label: string }) {
  return (
    <span
      className={`mono inline-flex items-center gap-1.5 rounded-full border px-2.5 py-[3px] text-[10px] uppercase tracking-[0.1em] ${
        STATE_STYLE[state] ?? STATE_STYLE[0]
      }`}
    >
      {state === 1 ? <span className="live-dot h-1 w-1 rounded-full bg-accent" /> : null}
      {label}
    </span>
  );
}

export function Badge({
  children,
  tone = "muted",
}: {
  children: ReactNode;
  tone?: "muted" | "accent" | "warn" | "danger";
}) {
  const tones = {
    muted: "text-muted border-line-2",
    accent: "text-accent border-accent/40",
    warn: "text-warn border-warn/40",
    danger: "text-danger border-danger/40",
  };
  return (
    <span
      className={`mono inline-flex rounded-full border px-2.5 py-[3px] text-[10px] uppercase tracking-[0.1em] ${tones[tone]}`}
    >
      {children}
    </span>
  );
}

type ButtonProps = {
  children: ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  variant?: "primary" | "ghost" | "danger" | "invert" | "onAccent";
  className?: string;
  type?: "button" | "submit";
};

export const BUTTON_BASE =
  "mono btn-lift inline-flex items-center justify-center gap-2 rounded-none border px-4 py-2.5 text-[13px] uppercase tracking-[0.1em] transition active:scale-[0.97] disabled:scale-100";

export const BUTTON_STYLES = {
  primary:
    "bg-accent text-[#08090a] border-accent hover:bg-text hover:border-text disabled:bg-line-2 disabled:border-line-2 disabled:text-muted",
  ghost:
    "bg-transparent text-text border-line-2 hover:border-accent hover:text-accent disabled:text-muted disabled:border-line",
  danger: "bg-transparent text-danger border-danger/50 hover:bg-danger/10 disabled:text-muted disabled:border-line",
  /// Solid ink on a light surface: used once, inside the accent slab.
  invert: "bg-[#08090a] text-accent border-[#08090a] hover:bg-[#08090a]/90",
  /// Outline for a second action sitting on the accent slab.
  onAccent: "bg-transparent text-[#08090a] border-[#08090a]/35 hover:border-[#08090a]/70 hover:bg-[#08090a]/5",
} as const;

export type ButtonVariant = keyof typeof BUTTON_STYLES;

export function Button({ children, onClick, disabled, variant = "primary", className = "", type = "button" }: ButtonProps) {
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      className={`${BUTTON_BASE} disabled:cursor-not-allowed ${BUTTON_STYLES[variant]} ${className}`}
    >
      {children}
    </button>
  );
}

/// Navigation that looks like a button. A <button> wrapped in an <a> is invalid HTML and gives one
/// control two tab stops; a destination belongs on the anchor itself. R-39.
export function ButtonLink({
  href,
  children,
  variant = "primary",
  className = "",
}: {
  href: string;
  children: ReactNode;
  variant?: ButtonVariant;
  className?: string;
}) {
  return (
    <Link href={href} className={`${BUTTON_BASE} ${BUTTON_STYLES[variant]} ${className}`}>
      {children}
    </Link>
  );
}

/// A field always shows its label. A placeholder is not a label: it disappears exactly when the
/// user needs it. R-39.
export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="flex flex-col gap-2">
      <span className="label">{label}</span>
      {children}
      {hint ? <span className="text-[11px] leading-relaxed text-muted">{hint}</span> : null}
    </label>
  );
}

export const inputClass =
  "w-full rounded-none border border-line-2 bg-panel-2 px-3 py-2.5 text-sm transition-colors placeholder:text-muted/60 focus:border-accent/60 focus:outline-none";

/// An empty state says why it is empty and what fills it. "No data" tells the reader nothing.
/// The children are wrapped in a div rather than a paragraph: callers pass blocks and buttons, and
/// a block inside a <p> is invalid HTML that React reports as a hydration mismatch.
export function Empty({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-3 rounded-[16px] border border-dashed border-line-2 px-6 py-16 text-center">
      <div className="flex max-w-md flex-col items-center gap-3 text-sm leading-relaxed text-muted">{children}</div>
      {action}
    </div>
  );
}

export function Spinner({ label }: { label?: string }) {
  return (
    <span className="mono inline-flex items-center gap-2 text-xs text-muted">
      <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-accent" />
      {label ?? "loading"}
    </span>
  );
}

/// Money is in custody right now. Three rings leave the dot; when the escrow is empty it is a
/// dead dot. The motion is the state, and it is the only ambient loop on a job page.
export function LockPulse({ label, active }: { label: string; active: boolean }) {
  return (
    <span className="inline-flex items-center gap-2">
      <svg viewBox="0 0 32 32" width="20" height="20" aria-hidden="true" className="shrink-0">
        {active ? (
          <>
            <circle className="sonar-ring" cx="16" cy="16" r="3" fill="none" stroke="var(--color-accent)" />
            <circle className="sonar-ring sonar-ring-2" cx="16" cy="16" r="3" fill="none" stroke="var(--color-accent)" />
            <circle className="sonar-ring sonar-ring-3" cx="16" cy="16" r="3" fill="none" stroke="var(--color-accent)" />
          </>
        ) : null}
        <circle cx="16" cy="16" r="2.5" fill={active ? "var(--color-accent)" : "var(--color-line-2)"} />
      </svg>
      <span className="label">{label}</span>
    </span>
  );
}

/// The clock that decides the job. One arc for what is left, and while it runs, sonar rings that
/// say the stakes are in custody. The motion is the state, not decoration.
export function CountdownRing({
  progress,
  label,
  value,
  state = "running",
  size = 168,
  arc = true,
}: {
  progress: number;
  label: string;
  value: string;
  state?: "running" | "done" | "late";
  size?: number;
  /// False when the window's start is not knowable: the dial turns so the clock reads as live,
  /// but no arc is drawn, because a proportion we cannot compute would be a claim we cannot back.
  arc?: boolean;
}) {
  const clamped = Math.max(0, Math.min(1, progress));
  const radius = 62;
  const circumference = 2 * Math.PI * radius;
  const tone = state === "late" ? "var(--color-danger)" : state === "done" ? "var(--color-text)" : "var(--color-accent)";

  return (
    <div className="relative inline-flex items-center justify-center" style={{ width: size, height: size }}>
      <svg viewBox="0 0 160 160" width={size} height={size} className="-rotate-90" aria-hidden="true">
        <circle
          cx="80"
          cy="80"
          r={radius}
          fill="none"
          stroke="var(--color-line)"
          strokeWidth="1.5"
          strokeDasharray={arc ? undefined : "2 6"}
          className={arc ? undefined : "animate-[spin_40s_linear_infinite] origin-[80px_80px]"}
        />
        {arc ? (
          <circle
            cx="80"
            cy="80"
            r={radius}
            fill="none"
            stroke={tone}
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeDasharray={circumference}
            strokeDashoffset={circumference * (1 - clamped)}
            style={{ transition: "stroke-dashoffset 600ms linear" }}
          />
        ) : null}
      </svg>
      <div className="absolute inset-0 flex flex-col items-center justify-center gap-1 text-center">
        <span className="label">{label}</span>
        <span className="mono text-[19px] leading-none tabular-nums text-text">{value}</span>
      </div>
    </div>
  );
}
