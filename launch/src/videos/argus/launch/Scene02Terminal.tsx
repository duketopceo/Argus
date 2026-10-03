import React from 'react';
import {Easing, interpolate, useCurrentFrame} from 'remotion';
import {TerminalPlate} from '../../../core/TerminalScene';
import {KineticType} from '../../../core/KineticType';
import {color, motion, radius} from '../../../brands/argus/tokens';
import {useSquare} from '../../../core/Stage';

/**
 * Scene 02 — Terminal (270f = 4.5s).
 * Real VHS capture of `argus-reviewer init` — the "What runs and what it
 * costs" block lands and holds. Plate enters fast, kinetic claim under it.
 */
export const Scene02Terminal: React.FC = () => {
  const frame = useCurrentFrame();
  const enter = interpolate(frame, [0, 16], [0, 1], {
    extrapolateRight: 'clamp',
    easing: Easing.bezier(...motion.easeOut),
  });
  const sq = useSquare();
  const beatIn = interpolate(frame, [196, 208], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });

  return (
    <div style={{position: 'absolute', inset: 0, background: color.canvas}}>
      <div
        style={{
          position: 'absolute',
          left: (1920 - 1375) / 2,
          top: 60,
          opacity: enter,
          transform: `scale(${interpolate(enter, [0, 1], [0.94, 1])}) translateY(${interpolate(enter, [0, 1], [30, 0])}px)`,
        }}
      >
        {/* tape is 7.8s @25fps; skip to ~4.1s so "what runs/costs" types in
            and settles before the beat line lands */}
        <TerminalPlate
          src="captures/init.mp4"
          startFrom={246}
          width={1375}
          height={925}
        />
      </div>
      <div
        style={{
          position: 'absolute',
          left: 0,
          right: 0,
          bottom: sq.beatBottom(150),
          display: 'flex',
          justifyContent: 'center',
        }}
      >
        <div
          style={{
            background: `${color.canvas}F2`,
            padding: '16px 32px',
            borderRadius: radius.md,
            opacity: beatIn,
          }}
        >
          <KineticType
            text="Your keys. Your models. Your runner."
            delay={200}
            size={sq.beatFont(64)}
            staggerMs={50}
          />
        </div>
      </div>
    </div>
  );
};
