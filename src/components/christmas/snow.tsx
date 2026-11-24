"use client";

import { useEffect, useRef } from "react";
import { allowsDecorativeMotion, readRenderProfile } from "@/lib/perf/profile";

/**
 * Falling snow on a single canvas.
 *
 * Deliberately cheap: one canvas, one animation frame loop, a bounded particle
 * count that scales with the viewport, integer positions, no shadows, no
 * off-screen work. The loop stops when the tab is hidden, when the OS asks for
 * reduced motion, when `?profile=safe`/`reduced` is set, and when the component
 * unmounts.
 *
 * The loop is also capped at ~30 fps. It is a full-viewport overlay that sits
 * above every page, so at 60 fps it kept the compositor and the GPU awake for a
 * decoration nobody can see moving at that rate; halving the frames halves that
 * cost with no visible difference on drifting flakes.
 */
export function SnowLayer({ density = 1 }: { density?: number }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    if (typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      return;
    }
    if (!allowsDecorativeMotion(readRenderProfile())) return;

    const context = canvas.getContext("2d", { alpha: true });
    if (!context) return;

    let width = 0;
    let height = 0;
    let raf = 0;
    let last = 0;
    let active = true;

    interface Flake {
      x: number;
      y: number;
      r: number;
      vy: number;
      vx: number;
      drift: number;
      alpha: number;
      hue: string;
    }
    let flakes: Flake[] = [];

    const palette = ["#ffffff", "#dff1ff", "#f3c96b", "#ffd9df"];

    const build = () => {
      const rect = canvas.getBoundingClientRect();
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      width = Math.max(1, Math.floor(rect.width));
      height = Math.max(1, Math.floor(rect.height));
      canvas.width = Math.floor(width * dpr);
      canvas.height = Math.floor(height * dpr);
      context.setTransform(dpr, 0, 0, dpr, 0, 0);

      const target = Math.round(Math.min(70, Math.max(14, (width * height) / 26000)) * density);
      flakes = Array.from({ length: target }, () => ({
        x: Math.random() * width,
        y: Math.random() * height,
        r: 0.7 + Math.random() * 1.9,
        vy: 9 + Math.random() * 20,
        vx: -6 + Math.random() * 12,
        drift: Math.random() * Math.PI * 2,
        alpha: 0.25 + Math.random() * 0.5,
        hue: palette[Math.floor(Math.random() * palette.length)],
      }));
    };

    /** ~30 fps. `last` is only advanced on a painted frame, so `delta` stays honest. */
    const FRAME_MS = 33;

    const frame = (now: number) => {
      if (!active) return;
      raf = window.requestAnimationFrame(frame);
      if (now - last < FRAME_MS) return;

      const delta = last ? Math.min(48, now - last) : 16;
      last = now;

      // Nothing to draw: the canvas is collapsed (`display: none`) or the
      // viewport has no area. Keep the loop parked instead of painting.
      if (width < 2 || height < 2) return;

      context.clearRect(0, 0, width, height);
      for (const flake of flakes) {
        flake.drift += delta * 0.0012;
        flake.y += (flake.vy * delta) / 1000;
        flake.x += ((flake.vx + Math.sin(flake.drift) * 12) * delta) / 1000;
        if (flake.y - flake.r > height) {
          flake.y = -flake.r * 2;
          flake.x = Math.random() * width;
        }
        if (flake.x < -8) flake.x = width + 8;
        if (flake.x > width + 8) flake.x = -8;

        context.globalAlpha = flake.alpha;
        context.fillStyle = flake.hue;
        context.beginPath();
        context.arc(flake.x, flake.y, flake.r, 0, Math.PI * 2);
        context.fill();
      }
      context.globalAlpha = 1;
    };

    const start = () => {
      if (!active || raf) return;
      last = 0;
      raf = window.requestAnimationFrame(frame);
    };
    const stop = () => {
      if (raf) window.cancelAnimationFrame(raf);
      raf = 0;
    };

    const onVisibility = () => {
      if (document.hidden) stop();
      else start();
    };
    const onResize = () => {
      build();
    };

    build();
    start();
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("resize", onResize, { passive: true });

    return () => {
      active = false;
      stop();
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("resize", onResize);
    };
  }, [density]);

  return <canvas ref={canvasRef} className="xmas-snow" aria-hidden="true" />;
}
