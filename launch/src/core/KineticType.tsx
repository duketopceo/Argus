import React from 'react';
import {
  Easing,
  interpolate,
  useCurrentFrame,
  useVideoConfig,
} from 'remotion';
import {color, font, motion} from '../brands/argus/tokens';

/**
 * Kinetic headline — words rise + settle in stagger, one idea per instance.
 * Per spec: Schibsted Grotesk, ≥48px at 1080p, hard cut in/out, no drift.
 */
export const KineticType: React.FC<{
  text: string;
  delay?: number;
  size?: number;
  weight?: number;
  staggerMs?: number;
  ink?: string;
  align?: 'center' | 'left';
}> = ({
  text,
  delay = 0,
  size = 96,
  weight = 700,
  staggerMs = 55,
  ink = color.ink,
  align = 'center',
}) => {
  const frame = useCurrentFrame() - delay;
  const {fps} = useVideoConfig();
  const words = text.split(' ');
  const staggerF = Math.round((staggerMs / 1000) * fps);

  return (
    <div
      style={{
        display: 'flex',
        flexWrap: 'wrap',
        justifyContent: align === 'center' ? 'center' : 'flex-start',
        columnGap: size * 0.26,
        fontFamily: font.grotesk,
        fontWeight: weight,
        fontSize: size,
        color: ink,
        letterSpacing: '-0.02em',
        lineHeight: 1.04,
      }}
    >
      {words.map((w, i) => {
        const w0 = i * staggerF;
        const t = Math.max(0, frame - w0);
        const y = interpolate(t, [0, 14], [size * 0.55, 0], {
          extrapolateLeft: 'clamp',
          extrapolateRight: 'clamp',
          easing: Easing.bezier(...motion.easeOut),
        });
        const o = interpolate(t, [0, 8], [0, 1], {
          extrapolateLeft: 'clamp',
          extrapolateRight: 'clamp',
        });
        return (
          <span
            key={i}
            style={{
              display: 'inline-block',
              opacity: o,
              transform: `translateY(${y}px)`,
            }}
          >
            {w}
          </span>
        );
      })}
    </div>
  );
};

/**
 * Mono kicker — Martian Mono caption line that types itself on.
 * For evidence lines (SHAs, spend) that must feel machine-true.
 */
export const MonoLine: React.FC<{
  text: string;
  delay?: number;
  size?: number;
  ink?: string;
  weight?: number;
}> = ({text, delay = 0, size = 30, ink = color.ink3, weight = 500}) => {
  const frame = useCurrentFrame() - delay;
  const {fps} = useVideoConfig();
  const chars = Math.floor(
    interpolate(frame, [0, Math.max(6, text.length * 0.55)], [0, text.length], {
      extrapolateLeft: 'clamp',
      extrapolateRight: 'clamp',
    })
  );
  const done = chars >= text.length;
  return (
    <div
      style={{
        fontFamily: font.mono,
        fontWeight: weight,
        fontSize: size,
        color: ink,
        letterSpacing: '0.01em',
        whiteSpace: 'pre',
      }}
    >
      {text.slice(0, chars)}
      {!done && <span style={{opacity: 0.85}}>▌</span>}
      {done && <span style={{opacity: 0}}>▌</span>}
    </div>
  );
};
