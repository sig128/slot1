"use client";

import { Switch } from "radix-ui";
import { useId } from "react";

export function Toggle({
  label,
  description,
  checked,
  onChange,
  disabled,
  danger,
}: {
  label: string;
  description?: React.ReactNode;
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
  danger?: boolean;
}) {
  const id = useId();
  return (
    <div className="flex items-start justify-between gap-6 py-3">
      <div className="min-w-0">
        <label htmlFor={id} className="block text-[0.95rem] text-ivory">
          {label}
        </label>
        {description && <p className="mt-0.5 max-w-[62ch] text-[0.82rem] text-ivory-3">{description}</p>}
      </div>
      <Switch.Root
        id={id}
        checked={checked}
        onCheckedChange={onChange}
        disabled={disabled}
        className={`relative h-6 w-11 shrink-0 rounded-full border transition-colors disabled:opacity-40 ${
          checked ? (danger ? "border-coral bg-coral" : "border-ivory bg-ivory") : "border-line-strong bg-graphite-700"
        }`}
      >
        <Switch.Thumb className={`block h-4 w-4 translate-x-1 rounded-full transition-transform data-[state=checked]:translate-x-6 ${checked ? "bg-graphite" : "bg-ivory-2"}`} />
      </Switch.Root>
    </div>
  );
}
