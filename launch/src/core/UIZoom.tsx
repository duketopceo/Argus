import React from 'react';
import {
  Easing,
  interpolate,
  useCurrentFrame,
} from 'remotion';
import {motion} from '../brands/argus/tokens';

export type CameraKey = {
  at: number; // local frame
  x: number; // focus point in content px
  y: number;
  scale: number;
};

/**
 * Camera rig: children live in content coordinates; the rig dollies between
 * keyframed focus points. Fast accel → sudden decel → hold, per Ocellus
 * motion language. No floaty drift — keys hold flat between moves.
 */
export const UIZoom: React.FC<{
  keys: CameraKey[];
  width: number; // content canvas px
  height: number;
  children: React.ReactNode;
}> = ({keys, width, height, children}) => {
  const frame = useCurrentFrame();
  // Viewport is the authored stage (width/height props), not the output
  // canvas — the 1:1 cut fits the 1920x1080 stage inside StageFit, so camera
  // math must stay in stage coordinates.
  const vw = width;
  const vh = height;

  const times = keys.map((k) => k.at);
  const xs = keys.map((k) => k.x);
  const ys = keys.map((k) => k.y);
  const ss = keys.map((k) => k.scale);

  const x = interpolate(frame, times, xs, {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
    easing: Easing.bezier(...motion.easeInOut),
  });
  const y = interpolate(frame, times, ys, {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
    easing: Easing.bezier(...motion.easeInOut),
  });
  const s = interpolate(frame, times, ss, {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
    easing: Easing.bezier(...motion.easeInOut),
  });

  return (
    <div
      style={{
        position: 'absolute',
        inset: 0,
        overflow: 'hidden',
      }}
    >
      <div
        style={{
          position: 'absolute',
          left: vw / 2 - x * s,
          top: vh / 2 - y * s,
          width,
          height,
          transform: `scale(${s})`,
          transformOrigin: '0 0',
        }}
      >
        {children}
      </div>
    </div>
  );
};
