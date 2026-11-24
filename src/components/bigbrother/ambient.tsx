"use client";

import { useEffect, useState } from "react";

/**
 * BIGBROTHER's animated identity.
 *
 * Two copies of the word travel toward each other from the top and bottom of the
 * viewport. They meet in the centre, the palette transitions, and the cycle
 * repeats. The movement is CSS transform/opacity only; the palette switch is the
 * only JavaScript work, fired once per collision.
 */

const PALETTES: Array<[number, number]> = [
  [262, 190],
  [288, 168],
  [210, 282],
  [322, 196],
  [172, 240],
  [264, 142],
];

export function BigBrotherAmbient({
  enabled,
  cycleMs = 22_000,
}: {
  enabled: boolean;
  cycleMs?: number;
}) {
  const [palette, setPalette] = useState(0);
  const [paused, setPaused] = useState(false);

  useEffect(() => {
    if (!enabled) return;
    // The collision happens at the halfway point of the cycle; that is when the
    // background colour changes.
    const timer = setInterval(() => {
      setPalette((current) => (current + 1) % PALETTES.length);
    }, Math.round(cycleMs / 2));
    return () => clearInterval(timer);
  }, [enabled, cycleMs]);

  useEffect(() => {
    const onVisibility = () => setPaused(document.hidden);
    onVisibility();
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, []);

  const [hueA, hueB] = PALETTES[palette];

  return (
    <div
      aria-hidden="true"
      className={`bb-stage ${paused ? "bb-paused" : ""}`}
      data-anim={enabled ? "on" : "off"}
      style={
        {
          "--bb-hue-a": hueA,
          "--bb-hue-b": hueB,
          "--bb-cycle": `${cycleMs}ms`,
        } as React.CSSProperties
      }
    >
      <div className="bb-collision" />
      <div className="bb-word-layer bb-depth-3 bb-word-down">BIGBROTHER</div>
      <div className="bb-word-layer bb-depth-2 bb-word-down">BIGBROTHER</div>
      <div className="bb-word-layer bb-depth-1 bb-word-down">BIGBROTHER</div>
      <div className="bb-word-layer bb-depth-3 bb-word-up">BIGBROTHER</div>
      <div className="bb-word-layer bb-depth-2 bb-word-up">BIGBROTHER</div>
      <div className="bb-word-layer bb-depth-1 bb-word-up">BIGBROTHER</div>
      <div className="bb-grain" />
    </div>
  );
}
