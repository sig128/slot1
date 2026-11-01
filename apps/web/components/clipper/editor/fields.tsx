"use client";

import { useState, type ReactNode } from "react";
import { editTime, parseEditTime } from "@/lib/clipper";

/** A titled inspector section; its title names the region for assistive tech. */
export function Panel({ title, children, actions }: { title: string; children: ReactNode; actions?: ReactNode }) {
  return (
    <section aria-label={title} className="min-w-0">
      <div className="mb-3 flex items-end justify-between gap-2 border-b hairline pb-2">
        <h2 className="font-display text-xl font-bold">{title}</h2>
        {actions}
      </div>
      {children}
    </section>
  );
}

export function RangeField({
  id,
  label,
  value,
  min,
  max,
  step,
  format,
  onChange,
  disabled,
}: {
  id: string;
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  format: (v: number) => string;
  onChange: (v: number) => void;
  disabled?: boolean;
}) {
  return (
    <div className="min-w-0">
      <label htmlFor={id} className="label flex justify-between gap-2">
        <span className="truncate">{label}</span>
        <span className="tnum shrink-0 text-ivory">{format(value)}</span>
      </label>
      <input id={id} type="range" min={min} max={max} step={step} value={value} disabled={disabled} onChange={(e) => onChange(Number(e.target.value))} className="w-full accent-[#ffad72]" />
    </div>
  );
}

/** A time typed as m:ss.s (or seconds); commits on blur or Enter. */
export function TimeField({ id, label, value, onCommit, disabled }: { id: string; label: string; value: number; onCommit: (ms: number) => void; disabled?: boolean }) {
  const [text, setText] = useState<string | null>(null);
  return (
    <div className="min-w-0">
      <label htmlFor={id} className="label">
        {label}
      </label>
      <input
        id={id}
        className="field tnum h-9"
        inputMode="decimal"
        disabled={disabled}
        value={text ?? editTime(value)}
        onFocus={() => setText(editTime(value))}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => {
          const ms = text === null ? null : parseEditTime(text);
          if (ms !== null && ms !== value) onCommit(ms);
          setText(null);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        }}
      />
    </div>
  );
}

export function SelectField<T extends string | number>({
  id,
  label,
  value,
  options,
  onChange,
  disabled,
}: {
  id: string;
  label: string;
  value: T;
  options: readonly (readonly [T, string])[];
  onChange: (v: T) => void;
  disabled?: boolean;
}) {
  return (
    <div className="min-w-0">
      <label htmlFor={id} className="label">
        {label}
      </label>
      <select
        id={id}
        className="field h-9"
        value={String(value)}
        disabled={disabled}
        onChange={(e) => {
          const hit = options.find(([v]) => String(v) === e.target.value);
          if (hit) onChange(hit[0]);
        }}
      >
        {options.map(([v, l]) => (
          <option key={String(v)} value={String(v)}>
            {l}
          </option>
        ))}
      </select>
    </div>
  );
}

export function Toggle({ id, label, hint, checked, onChange, disabled }: { id: string; label: string; hint?: ReactNode; checked: boolean; onChange: (v: boolean) => void; disabled?: boolean }) {
  return (
    <label htmlFor={id} className="flex items-start gap-3 text-sm">
      <input id={id} type="checkbox" className="mt-1 accent-[#ffad72]" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      <span className="min-w-0">
        {label}
        {hint && <span className="block text-[0.78rem] text-ivory-3">{hint}</span>}
      </span>
    </label>
  );
}

/** A row of radio buttons styled as one segmented control. */
export function Segmented<T extends string>({ label, value, options, onChange, columns }: { label: string; value: T; options: readonly (readonly [T, ReactNode])[]; onChange: (v: T) => void; columns?: number }) {
  return (
    <div role="radiogroup" aria-label={label} className="grid border hairline" style={{ gridTemplateColumns: `repeat(${columns ?? options.length}, minmax(0, 1fr))` }}>
      {options.map(([v, l]) => (
        <button
          key={v}
          type="button"
          role="radio"
          aria-checked={value === v}
          onClick={() => onChange(v)}
          className={`min-w-0 px-2 py-2 text-left text-[0.88rem] leading-tight ${value === v ? "select-bar" : "text-ivory-2 hover:text-ivory"}`}
        >
          {l}
        </button>
      ))}
    </div>
  );
}

export const pct = (v: number) => `${Math.round(v * 100)}%`;
export const secs = (ms: number) => `${(ms / 1000).toFixed(1)} s`;
