"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { BUTTON_BASE, BUTTON_STYLES, type ButtonVariant } from "@/components/ui";

const HEX = "0123456789ABCDEF";

/// A string of the same length as the label, so the button never changes width while it flickers.
function scramble(length: number): string {
  let out = "";
  for (let i = 0; i < length; i += 1) out += HEX[Math.floor(Math.random() * HEX.length)];
  return out;
}

/// A button whose label flips between its words and a hash every half second while it is hovered
/// or focused. The real label stays in the accessible name, so a screen reader never hears a hash.
export function HashButton({
  href,
  label,
  variant = "primary",
  className = "",
}: {
  href: string;
  label: string;
  variant?: ButtonVariant;
  className?: string;
}) {
  const [hover, setHover] = useState(false);
  const [showHash, setShowHash] = useState(false);
  const [hash, setHash] = useState("");

  useEffect(() => {
    if (!hover || window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      setShowHash(false);
      return;
    }

    setHash(scramble(label.length));
    setShowHash(true);
    const id = window.setInterval(() => {
      setHash(scramble(label.length));
      setShowHash((showing) => !showing);
    }, 500);

    return () => window.clearInterval(id);
  }, [hover, label.length]);

  return (
    <Link
      href={href}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onFocus={() => setHover(true)}
      onBlur={() => setHover(false)}
      className={`${BUTTON_BASE} ${BUTTON_STYLES[variant]} ${className}`}
    >
      <span aria-hidden="true">{showHash ? hash : label}</span>
      <span className="sr-only">{label}</span>
    </Link>
  );
}
