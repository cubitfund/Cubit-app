import { useEffect, useRef, useState } from "react";

// Four-pointed black sparkle, used sparingly.
export function Sparkle({ className = "", size = 16, color = "#111312" }: { className?: string; size?: number; color?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" className={className} aria-hidden>
      <path d="M12 0C12.6 6.4 17.6 11.4 24 12C17.6 12.6 12.6 17.6 12 24C11.4 17.6 6.4 12.6 0 12C6.4 11.4 11.4 6.4 12 0Z" fill={color} />
    </svg>
  );
}

// A monospace number that plays a stepped tick animation whenever it changes.
export function Ticker({ value, className = "" }: { value: string; className?: string }) {
  const [display, setDisplay] = useState(value);
  const [key, setKey] = useState(0);
  const prev = useRef(value);
  useEffect(() => {
    if (value !== prev.current) {
      prev.current = value;
      setDisplay(value);
      setKey((k) => k + 1);
    }
  }, [value]);
  return (
    <span key={key} className={`tick-up inline-block tabular-nums ${className}`}>
      {display}
    </span>
  );
}

export function Stamp({ children, className = "", color = "#5b4bff" }: { children: React.ReactNode; className?: string; color?: string }) {
  return (
    <span
      className={`inline-flex items-center gap-1 border-[2px] border-ink px-2 py-0.5 text-[10px] font-mono uppercase tracking-widest ${className}`}
      style={{ color }}
    >
      {children}
    </span>
  );
}
