"use client";

import dynamic from "next/dynamic";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { prefersReducedMotion, type ChristmasMode } from "./prefs";
import {
  applyRenderProfile,
  allowsDecorativeMotion,
  readRenderProfile,
  type RenderProfile,
} from "@/lib/perf/profile";

/**
 * The DARKNOTE introduction.
 *
 * This is part of the product, not a preference. It plays on every launch — a
 * browser tab, the installed PWA and the future APK alike — and there is no
 * switch, query parameter or stored value that suppresses it. The old
 * device-local `intro`/`introSeen`/`mode` options are ignored rather than
 * honoured, so a device that had turned the intro off will show it again after
 * this build.
 *
 * Accessibility is still respected: when the operating system asks for reduced
 * motion the same introduction renders with its animation neutralised
 * (`data-motion="reduced"`), instead of being skipped entirely.
 *
 * The snow canvas is loaded lazily; it is decorative and must never delay the
 * first paint or the hydration of the console.
 */
const SnowLayer = dynamic(() => import("./snow").then((module) => module.SnowLayer), { ssr: false });

interface ChristmasContextValue {
  /** Only the festive styling switch the shell needs; the intro is not optional. */
  mode: ChristmasMode;
  dismissIntro: () => void;
}

const ChristmasContext = createContext<ChristmasContextValue | null>(null);

/**
 * Lifts the pre-hydration boot shield (see `.xmas-boot` in globals.css). The
 * shield covers the console until the introduction has taken over, so the
 * dashboard never paints ahead of it.
 */
function releaseBootShield(): void {
  if (typeof document === "undefined") return;
  document.documentElement.dataset.xmasBoot = "done";
}

export function ChristmasProvider({ children }: { children: React.ReactNode }) {
  // Branding only: stored intro/snow/introSeen values are deliberately ignored.
  const mode: ChristmasMode = "on";
  const [introOpen, setIntroOpen] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const [reduced, setReduced] = useState(false);
  // `?profile=safe|reduced` — the diagnostic switch. Read on the client only.
  const [profile, setProfile] = useState<RenderProfile>("full");
  const timer = useRef<number | null>(null);

  // Motion preference drives the presentation, never whether the intro exists.
  useEffect(() => {
    const resolved = readRenderProfile();
    setProfile(resolved);
    applyRenderProfile(resolved);
    setReduced(prefersReducedMotion() || !allowsDecorativeMotion(resolved));
  }, []);

  // One attribute pair drives every festive style.
  useEffect(() => {
    if (typeof document === "undefined") return;
    const root = document.documentElement;
    root.dataset.christmas = mode;
    root.dataset.motion = reduced ? "reduced" : "full";
  }, [mode, reduced]);

  // Always. Tab, installed app, WebView and the future APK all take this path.
  useEffect(() => {
    setIntroOpen(true);
  }, []);

  // Auto-dismiss. Reduced motion keeps the same beat but without the long
  // animation, so a user who asked for less motion is not held on a title card.
  useEffect(() => {
    if (!introOpen) return;
    const holdMs = reduced ? 2_600 : 4_200;
    const fadeMs = reduced ? 200 : 620;
    timer.current = window.setTimeout(() => {
      setLeaving(true);
      // Reveal the console underneath while the intro fades out, not after it.
      releaseBootShield();
      timer.current = window.setTimeout(() => {
        setIntroOpen(false);
        setLeaving(false);
      }, fadeMs);
    }, holdMs);
    return () => {
      if (timer.current) window.clearTimeout(timer.current);
    };
  }, [introOpen, reduced]);

  const dismissIntro = useCallback(() => {
    if (timer.current) window.clearTimeout(timer.current);
    setLeaving(true);
    releaseBootShield();
    window.setTimeout(() => {
      setIntroOpen(false);
      setLeaving(false);
    }, reduced ? 180 : 420);
  }, [reduced]);

  const value = useMemo<ChristmasContextValue>(() => ({ mode, dismissIntro }), [dismissIntro, mode]);

  return (
    <ChristmasContext.Provider value={value}>
      {/* Installed apps paint this before hydration; it is display:none in a tab. */}
      <div className="xmas-boot" aria-hidden="true" />
      {children}
      {allowsDecorativeMotion(profile) ? <SnowLayer /> : null}
      {introOpen ? <ChristmasIntro leaving={leaving} onSkip={dismissIntro} /> : null}
    </ChristmasContext.Provider>
  );
}

export function useChristmas(): ChristmasContextValue {
  const context = useContext(ChristmasContext);
  if (!context) throw new Error("useChristmas must be used inside ChristmasProvider");
  return context;
}

/**
 * The introduction: dark screen, lights, snow, the glowing wordmark, the credit,
 * then a smooth exit into the dashboard. Content is static text — nothing here
 * fetches, so it costs one paint.
 */
function ChristmasIntro({ leaving, onSkip }: { leaving: boolean; onSkip: () => void }) {
  return (
    <div className="xmas-intro" data-leaving={leaving ? "true" : "false"} role="presentation">
      <div className="xmas-halo" aria-hidden="true" />
      <div className="xmas-lights" aria-hidden="true">
        {Array.from({ length: 14 }, (_, index) => (
          <i key={index} />
        ))}
      </div>

      <div className="relative z-10 px-6 text-center">
        <h1 className="xmas-brand">
          <span>DARKNOTE</span>
        </h1>
        <p className="xmas-credit">POWERED BY JIMMY M, TECH</p>
        <div className="xmas-ribbon mx-auto mt-8 h-px w-40 rounded-full opacity-70" aria-hidden="true" />
      </div>

      <button type="button" className="xmas-skip" onClick={onSkip}>
        Skip intro
      </button>
    </div>
  );
}
