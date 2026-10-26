import { useEffect, type RefObject } from "react";

/** Moves focus to `ref` on mount and back to whatever had it on unmount, so keyboard users don't get lost. */
export function useFocusWhileOpen(ref: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    const before = document.activeElement;
    ref.current?.focus();
    return () => {
      if (before instanceof HTMLElement) before.focus();
    };
  }, [ref]);
}
