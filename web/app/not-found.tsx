import Link from "next/link";

export default function NotFound() {
  return (
    <div className="mx-auto flex max-w-6xl flex-col items-start px-5 py-28">
      <div className="mono text-[10px] uppercase tracking-[0.18em] text-muted">404</div>
      <h1 className="mt-3 text-3xl tracking-[-0.01em]">nothing here.</h1>
      <p className="mt-3 max-w-md text-[13px] leading-relaxed text-muted">
        The page or job you asked for does not exist on this chain.
      </p>
      <Link
        href="/jobs"
        className="mono mt-8 inline-flex border border-accent bg-accent px-4 py-2.5 text-[10px] uppercase tracking-[0.12em] text-[#08090a]"
      >
        back to jobs
      </Link>
    </div>
  );
}
