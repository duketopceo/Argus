import React from 'react';
import {
  Easing,
  interpolate,
  spring,
  useCurrentFrame,
  useVideoConfig,
} from 'remotion';
import {color, motion, statusColor, StatusName} from './tokens';

const LID_PATH =
  'M20.1 3.4a.5.5 0 0 1 .5.5V12A8.6 8.6 0 1 1 12 3.4Z';

/**
 * The Argus mark — outer lid, iris ring, offset pupil — drawn from the
 * canonical mark.svg path data (viewBox 0 0 24). `draw` sweeps the lid on,
 * `open` springs the iris, `gaze` slides the pupil to its offset.
 */
export const EyeMark: React.FC<{
  size: number;
  lidDraw?: number; // 0..1 stroke draw of the lid arc
  irisOpen?: number; // 0..1 iris scale-in
  gaze?: number; // 0..1 pupil travel to final offset
  blink?: number; // 0..1 scaleY squash (0.15 = shut)
  tint?: string;
  strokeWidth?: number;
}> = ({
  size,
  lidDraw = 1,
  irisOpen = 1,
  gaze = 1,
  blink = 0,
  tint = color.accent,
  strokeWidth = 1.75,
}) => {
  const lidLen = 62; // generous path length for dash sweep
  const pupilX = interpolate(gaze, [0, 1], [12.636, 13.414]);
  const pupilY = interpolate(gaze, [0, 1], [11.364, 10.586]);
  const squash = interpolate(blink, [0, 1], [1, 0.15]);

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      style={{transform: `scaleY(${squash})`}}
    >
      <path
        d={LID_PATH}
        stroke={tint}
        strokeWidth={strokeWidth}
        strokeLinejoin="round"
        strokeDasharray={lidLen}
        strokeDashoffset={lidLen * (1 - lidDraw)}
      />
      <circle
        cx={12.636}
        cy={11.364}
        r={4.25 * irisOpen}
        stroke={tint}
        strokeWidth={strokeWidth}
        opacity={irisOpen}
      />
      <circle
        cx={pupilX}
        cy={pupilY}
        r={2 * Math.min(1, irisOpen * 1.4)}
        fill={tint}
        opacity={gaze}
      />
    </svg>
  );
};

/**
 * Fully self-animated "eye opens" for the hook: lid draws on, iris springs
 * open, pupil settles into its gaze offset. ~0.9s at 60fps.
 */
export const EyeOpen: React.FC<{
  size: number;
  delay?: number;
  tint?: string;
}> = ({size, delay = 0, tint}) => {
  const frame = useCurrentFrame() - delay;
  const {fps} = useVideoConfig();
  const lidDraw = interpolate(frame, [2, 16], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
    easing: Easing.bezier(...motion.easeOut),
  });
  const irisOpen = spring({
    frame: Math.max(0, frame - 10),
    fps,
    config: {damping: 13, stiffness: 170, mass: 0.7},
  });
  const gaze = interpolate(frame, [22, 36], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
    easing: Easing.bezier(...motion.easeInOut),
  });
  return (
    <EyeMark
      size={size}
      lidDraw={lidDraw}
      irisOpen={irisOpen}
      gaze={gaze}
      tint={tint}
    />
  );
};

/**
 * Eye → status glyph: the mark scans (pupil saccades), blinks shut, and
 * resolves into the lane's terminal state glyph.
 */
export const EyeToStatus: React.FC<{
  size: number;
  status: StatusName;
  delay?: number; // frame at which the scan begins
  scanMs?: number;
}> = ({size, status, delay = 0, scanMs = 480}) => {
  const frame = useCurrentFrame();
  const local = frame - delay;
  const scanF = Math.round((scanMs / 1000) * 60);
  const blinkStart = scanF;
  const blinkEnd = blinkStart + 8;
  const settleEnd = blinkEnd + 10;

  // Saccade: two quick darts L→R then center
  const dart = (f: number) => {
    if (f < 0) return 0;
    if (f < scanF * 0.3) return interpolate(f, [0, scanF * 0.3], [0, -1]);
    if (f < scanF * 0.65)
      return interpolate(f, [scanF * 0.3, scanF * 0.65], [-1, 1]);
    return interpolate(f, [scanF * 0.65, scanF], [1, 0]);
  };
  const gazeX = dart(local) * 2.4;

  // Blink: squash to near-shut and back
  const blink =
    local < blinkStart || local > blinkEnd
      ? 0
      : 1 -
        Math.abs(
          (local - (blinkStart + blinkEnd) / 2) / ((blinkEnd - blinkStart) / 2)
        );

  // Crossfade: eye out as glyph in, across the blink
  const eyeOpacity = interpolate(local, [blinkStart + 3, blinkEnd], [1, 0], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });
  const glyphOpacity = interpolate(
    local,
    [blinkStart + 5, settleEnd],
    [0, 1],
    {extrapolateLeft: 'clamp', extrapolateRight: 'clamp'}
  );
  const glyphScale = interpolate(local, [blinkStart + 5, settleEnd], [0.7, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
    easing: Easing.out(Easing.back(1.6)),
  });

  return (
    <span
      style={{
        position: 'relative',
        display: 'inline-block',
        width: size,
        height: size,
      }}
    >
      <span style={{position: 'absolute', opacity: eyeOpacity}}>
        <EyeMark
          size={size}
          tint={color.ink2}
          gaze={0}
          blink={blink}
          strokeWidth={1.6}
        />
        {/* moving pupil rides over the mark's hidden one */}
        <svg
          width={size}
          height={size}
          viewBox="0 0 24 24"
          style={{
            position: 'absolute',
            inset: 0,
            transform: `scaleY(${interpolate(blink, [0, 1], [1, 0.15])})`,
          }}
        >
          <circle cx={13.414 + gazeX} cy={10.586} r={2} fill={color.ink2} />
        </svg>
      </span>
      <span
        style={{
          position: 'absolute',
          opacity: glyphOpacity,
          transform: `scale(${glyphScale})`,
        }}
      >
        <StatusGlyph status={status} size={size} />
      </span>
    </span>
  );
};

/** Static terminal-state glyph, canonical SVG geometry, tinted per status. */
export const StatusGlyph: React.FC<{
  status: StatusName;
  size: number;
}> = ({status, size}) => {
  const c = statusColor[status];
  const sw = 1.8;
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke={c}
      strokeWidth={sw}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {status === 'failed' && (
        <>
          <circle cx="12" cy="12" r="8" />
          <path d="M6.343 17.657 17.657 6.343" />
        </>
      )}
      {status === 'passed' && (
        <>
          <circle cx="12" cy="12" r="8" />
          <circle cx="12" cy="12" r="5" fill={c} stroke="none" />
        </>
      )}
      {status === 'skipped' && <path d="M4 10A8.5 8.5 0 0 0 20 10" />}
      {status === 'inconclusive' && (
        <>
          <circle cx="12" cy="12" r="8" />
          <path d="M4 12A8 8 0 0 1 20 12Z" fill={c} stroke="none" />
        </>
      )}
      {status === 'unavailable' && (
        <circle cx="12" cy="12" r="8" strokeDasharray="2.2 4.083" />
      )}
      {status === 'blocked' && (
        <>
          <circle cx="12" cy="12" r="8" />
          <path d="M4 12H20" strokeWidth={2.4} />
        </>
      )}
    </svg>
  );
};
