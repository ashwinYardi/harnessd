// The harnessd H mark (assets/brand/, D-027). Two bars are the harnesses, the crossbar is
// the coordinator, and the ring cut through it is where they meet. It takes the text color.
export function BrandMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 48 48" aria-hidden="true" className={className} fill="currentColor">
      <path
        fillRule="evenodd"
        d="M0 0L10 0L10 17L38 17L38 0L48 0L48 48L38 48L38 31L10 31L10 48L0 48zM19 24a5 5 0 1 0 10 0a5 5 0 1 0 -10 0z"
      />
    </svg>
  );
}

/** The mark and "harnessd", with the final "d" in the Junction accent (assets/brand/README.md). */
export function BrandLockup() {
  return (
    <span className="inline-flex items-center gap-2">
      <BrandMark className="size-4" />
      <span className="font-semibold text-sm tracking-tight">
        harness<span className="text-[light-dark(#0B7666,#3CC6B0)]">d</span>
      </span>
    </span>
  );
}
