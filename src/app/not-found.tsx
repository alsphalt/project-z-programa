import Link from "next/link";

export default function NotFound() {
  return (
    <main className="mx-auto grid min-h-dvh w-full max-w-md place-items-center px-4">
      <div className="w-full rounded-xl border border-ink-700/70 bg-ink-900/80 p-6 shadow-panel">
        <p className="text-[10px] font-semibold uppercase tracking-[0.2em] text-accent-soft">DARKNOTE / 404</p>
        <h1 className="mt-2 text-lg font-semibold text-slate-100">That panel does not exist</h1>
        <p className="mt-2 text-xs leading-relaxed text-slate-400">
          The address is not part of the control center. Nothing was changed in your servers, projects or files.
        </p>
        <Link href="/" className="btn-primary mt-5 w-full justify-center">
          Back to overview
        </Link>
      </div>
    </main>
  );
}
