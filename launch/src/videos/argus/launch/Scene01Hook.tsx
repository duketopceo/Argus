import React from 'react';
import {useCurrentFrame, interpolate} from 'remotion';
import {EyeOpen} from '../../../brands/argus/EyeMark';
import {KineticType} from '../../../core/KineticType';
import {color} from '../../../brands/argus/tokens';

/**
 * Scene 01 — Hook (0–2.5s, 150f @60).
 * Black canvas → the eye draws itself open → pupil settles its gaze →
 * headline lands word by word. Cobalt only on the mark.
 */
export const Scene01Hook: React.FC = () => {
  const frame = useCurrentFrame();
  // First frame must be a meaningful autoplay still: mark begins at f2,
  // so f0 shows the canvas + a faint lid position via EyeOpen's dashoffset.
  const lift = interpolate(frame, [120, 150], [0, -18], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });
  return (
    <div
      style={{
        position: 'absolute',
        inset: 0,
        background: color.canvas,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 64,
        transform: `translateY(${lift}px)`,
      }}
    >
      <EyeOpen size={190} delay={2} tint={color.accent} />
      <KineticType
        text="Every PR gets a witness."
        delay={48}
        size={104}
        staggerMs={60}
      />
    </div>
  );
};
