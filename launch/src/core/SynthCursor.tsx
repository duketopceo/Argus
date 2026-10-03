import React from 'react';
import {
  Easing,
  interpolate,
  useCurrentFrame,
} from 'remotion';
import {color, motion} from '../brands/argus/tokens';

export type CursorKey = {at: number; x: number; y: number; click?: boolean};

/**
 * Synthetic cursor in content coordinates — pair with UIZoom so it rides the
 * camera. Waypoints interpolate position; `click: true` fires a ripple ring.
 * Lives on the same content plane as the UI so scale follows the camera.
 */
export const SynthCursor: React.FC<{
  keys: CursorKey[];
}> = ({keys}) => {
  const frame = useCurrentFrame();
  const times = keys.map((k) => k.at);
  const x = interpolate(
    frame,
    times,
    keys.map((k) => k.x),
    {
      extrapolateLeft: 'clamp',
      extrapolateRight: 'clamp',
      easing: Easing.bezier(...motion.easeInOut),
    }
  );
  const y = interpolate(
    frame,
    times,
    keys.map((k) => k.y),
    {
      extrapolateLeft: 'clamp',
      extrapolateRight: 'clamp',
      easing: Easing.bezier(...motion.easeInOut),
    }
  );

  return (
    <>
      {keys
        .filter((k) => k.click)
        .map((k, i) => {
          const t = frame - k.at;
          if (t < 0 || t > 22) return null;
          const r = interpolate(t, [0, 22], [6, 44]);
          const o = interpolate(t, [0, 22], [0.9, 0]);
          return (
            <div
              key={i}
              style={{
                position: 'absolute',
                left: k.x - r,
                top: k.y - r,
                width: r * 2,
                height: r * 2,
                borderRadius: '50%',
                border: `2.5px solid ${color.accent}`,
                opacity: o,
              }}
            />
          );
        })}
      <div
        style={{
          position: 'absolute',
          left: x - 3,
          top: y - 3,
          width: 16,
          height: 16,
          borderRadius: '50%',
          background: color.ink,
          boxShadow: `0 0 0 3px ${color.canvas}`,
        }}
      />
    </>
  );
};
