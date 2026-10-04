import React from 'react';
import {
  AbsoluteFill,
  Easing,
  interpolate,
  useCurrentFrame,
} from 'remotion';
import {color} from '../../../brands/argus/tokens';
import {EyeOpen, StatusGlyph} from '../../../brands/argus/EyeMark';
import {KineticType} from '../../../core/KineticType';

// README loop — 7.5s: eye opens -> claim -> four lane states -> spend proof.
// All real glyphs/numbers; designed to loop (dark -> eye draws open each pass).
const LANES = [
  {state: 'failed' as const, word: 'review', tint: color.failed},
  {state: 'passed' as const, word: 'flow', tint: color.passed},
  {state: 'skipped' as const, word: 'app', tint: color.ink3},
  {state: 'inconclusive' as const, word: 'a0', tint: color.caution},
];

export const LoopReadme: React.FC = () => {
  const frame = useCurrentFrame();

  const laneIn = (i: number) =>
    interpolate(frame, [150 + i * 24, 168 + i * 24], [0, 1], {
      extrapolateLeft: 'clamp',
      extrapolateRight: 'clamp',
      easing: Easing.bezier(0.2, 0, 0, 1),
    });

  const spendIn = interpolate(frame, [300, 322], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
    easing: Easing.bezier(0.2, 0, 0, 1),
  });

  const outFade = interpolate(frame, [420, 449], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });

  return (
    <AbsoluteFill style={{background: color.canvas}}>
      <div
        style={{
          position: 'absolute',
          top: 120,
          left: 0,
          right: 0,
          display: 'flex',
          justifyContent: 'center',
        }}
      >
        <EyeOpen size={240} delay={4} tint={color.accent} />
      </div>

      <div
        style={{
          position: 'absolute',
          top: 420,
          left: 0,
          right: 0,
          textAlign: 'center',
        }}
      >
        <KineticType
          text="Every PR gets a witness."
          delay={52}
          size={84}
          staggerMs={34}
        />
      </div>

      <div
        style={{
          position: 'absolute',
          top: 640,
          left: 0,
          right: 0,
          display: 'flex',
          justifyContent: 'center',
          gap: 72,
        }}
      >
        {LANES.map((l, i) => (
          <div
            key={l.word}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 18,
              opacity: laneIn(i),
              transform: `translateY(${interpolate(laneIn(i), [0, 1], [18, 0])}px)`,
            }}
          >
            <StatusGlyph status={l.state} size={54} />
            <span
              style={{
                fontSize: 42,
                color: l.tint,
                fontFamily: 'Martian Mono, monospace',
              }}
            >
              {l.word}
            </span>
          </div>
        ))}
      </div>

      <div
        style={{
          position: 'absolute',
          bottom: 90,
          left: 0,
          right: 0,
          textAlign: 'center',
          opacity: spendIn,
        }}
      >
        <span
          style={{
            fontFamily: 'Martian Mono, monospace',
            fontSize: 54,
            color: color.passed,
          }}
        >
          $0.000000
        </span>
        <span
          style={{
            fontFamily: 'Martian Mono, monospace',
            fontSize: 34,
            color: color.ink3,
          }}
        >
          {' '}
          cached re-run
        </span>
      </div>

      <AbsoluteFill style={{background: color.canvas, opacity: outFade}} />
    </AbsoluteFill>
  );
};
