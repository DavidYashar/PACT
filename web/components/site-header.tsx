"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useAccount } from "wagmi";
import { useIsAdmin, useIsTreasury } from "@/lib/admin";
import { BUTTON_BASE, BUTTON_STYLES } from "./ui";
import { ConnectButton } from "./connect-button";

const LINKS = [
  { href: "/jobs", label: "jobs" },
  { href: "/talents", label: "talents" },
  { href: "/swap", label: "swap" },
  { href: "/new", label: "post" },
  { href: "/tickets", label: "tickets" },
  { href: "/account", label: "account" },
  { href: "/skill", label: "skill" },
];

export function SiteHeader() {
  const pathname = usePathname();
  const { address } = useAccount();
  const { isAdmin } = useIsAdmin(address);
  const { isTreasury } = useIsTreasury(address);

  const [open, setOpen] = useState(false);
  const [mounted, setMounted] = useState(false);
  const menuRef = useRef<HTMLButtonElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);

  /// The drawer is portalled to the body: the header has a backdrop filter, and a filter makes its
  /// box the containing block for `position: fixed`. Inside the header, `inset-0` would mean 64px.
  useEffect(() => {
    setMounted(true);
  }, []);

  /// A route change closes the drawer; otherwise it would sit over whatever page came next.
  useEffect(() => {
    setOpen(false);
  }, [pathname]);

  useEffect(() => {
    if (!open) return;

    closeRef.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("keydown", onKey);

    /// The page behind a full-height drawer must not scroll under it.
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = previous;
    };
  }, [open]);

  function close() {
    setOpen(false);
    menuRef.current?.focus();
  }

  const linkClass = (active: boolean, block: boolean, tone: "nav" | "accent" = "nav") =>
    `${block ? "flex items-center py-3 text-[15px]" : "flex items-center text-[13px] sm:text-[14px]"} uppercase leading-none tracking-[0.06em] transition-colors ${
      tone === "accent"
        ? active
          ? "text-accent"
          : "text-accent/70 hover:text-accent"
        : active
          ? "text-text"
          : "text-muted hover:text-text"
    }`;

  /// Rendered twice: the bar on a wide screen, and the drawer on a phone. Both are built from the
  /// same list, so a destination cannot exist in one and not the other.
  const items = (block: boolean) => (
    <>
      {LINKS.map((link) => {
        const active = pathname === link.href || pathname.startsWith(link.href + "/");
        return (
          <Link key={link.href} href={link.href} onClick={() => setOpen(false)} className={linkClass(active, block)}>
            {link.label}
          </Link>
        );
      })}

      {isTreasury ? (
        <Link
          href="/treasury"
          onClick={() => setOpen(false)}
          className={`${linkClass(pathname.startsWith("/treasury"), block, "accent")} gap-2`}
        >
          <span className="h-1 w-1 rounded-full bg-accent" />
          treasury
        </Link>
      ) : null}

      {isAdmin ? (
        <Link
          href="/admin"
          onClick={() => setOpen(false)}
          className={`${linkClass(pathname.startsWith("/admin"), block, "accent")} gap-2`}
        >
          <span className="h-1 w-1 rounded-full bg-accent" />
          admin
        </Link>
      ) : null}
    </>
  );

  const drawer = (
    <div
      id="site-menu"
      aria-hidden={!open}
      inert={!open}
      className={`fixed inset-0 z-50 sm:hidden ${open ? "" : "pointer-events-none"}`}
    >
      <div
        onClick={close}
        className={`absolute inset-0 bg-black/65 backdrop-blur-sm transition-opacity duration-300 ${
          open ? "opacity-100" : "opacity-0"
        }`}
      />

      <div
        className={`absolute inset-y-0 left-0 flex w-[290px] max-w-[85vw] flex-col border-r border-line bg-bg/80 backdrop-blur-xl transition-transform duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] ${
          open ? "translate-x-0" : "-translate-x-full"
        }`}
      >
        <div className="flex h-16 items-center justify-between border-b border-line px-5">
          <span className="flex items-center"><img src="/pact-logo.png" alt="PACT" width={257} height={200} draggable={false} className="h-9 w-auto select-none" /></span>
          <button
            ref={closeRef}
            onClick={close}
            className="mono text-[11px] uppercase tracking-[0.12em] text-muted transition-colors hover:text-text"
          >
            close
          </button>
        </div>

        <nav className="flex flex-col gap-1 overflow-y-auto px-5 py-3">{items(true)}</nav>

        <div className="mt-auto border-t border-line p-5">
          <ConnectButton stretch />
        </div>
      </div>
    </div>
  );

  return (
    <>
      <header className="sticky top-0 z-40 border-b border-line bg-bg/90 backdrop-blur-md">
        <div className="mx-auto flex h-16 max-w-6xl items-center gap-8 px-5">
          <Link
            href="/"
            aria-label="PACT, home"
            className="flex shrink-0 items-center rounded-[2px] transition-opacity duration-200 hover:opacity-75 focus-visible:opacity-75 focus-visible:outline-none"
          >
            <img
              src="/pact-logo.png"
              alt=""
              width={257}
              height={200}
              draggable={false}
              className="h-10 w-auto select-none"
            />
          </Link>

          <nav className="hidden items-center gap-8 sm:flex">{items(false)}</nav>

          <div className="ml-auto hidden sm:block">
            <ConnectButton />
          </div>

          {/* A phone gets one control instead of a nav row and a wallet button: the drawer holds both. */}
          <button
            ref={menuRef}
            onClick={() => setOpen(true)}
            aria-expanded={open}
            aria-controls="site-menu"
            className={`${BUTTON_BASE} ${BUTTON_STYLES.ghost} ml-auto sm:hidden`}
          >
            menu
          </button>
        </div>
      </header>

      {mounted ? createPortal(drawer, document.body) : null}
    </>
  );
}
