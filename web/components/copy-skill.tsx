"use client";

import { useState } from "react";
import { BUTTON_BASE, BUTTON_STYLES } from "./ui";

/// Copies the whole file as text, which is what an agent needs. The button says "copied" for a
/// moment so the action has a visible result even when the clipboard write is silent.
export function CopySkill({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);

  return (
    <button
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setCopied(true);
          setTimeout(() => setCopied(false), 1800);
        } catch {
          /// Clipboard access can be denied. The download link beside this button still works.
        }
      }}
      className={`${BUTTON_BASE} ${BUTTON_STYLES.primary}`}
    >
      {copied ? "copied" : "copy the file"}
    </button>
  );
}
