import React from 'react';
import {
  Easing,
  Img,
  interpolate,
  OffthreadVideo,
  staticFile,
  useCurrentFrame,
} from 'remotion';
import {TerminalPlate} from '../../../core/TerminalScene';
import {KineticType} from '../../../core/KineticType';
import {color, font, motion, radius} from '../../../brands/argus/tokens';
import {StatusGlyph} from '../../../brands/argus/EyeMark';
import {useSquare} from '../../../core/Stage';

/**
 * Scene 06 — Surface montage (360f = 6s).
 * Three hard cuts in place — evidence report (real U14 render), terminal
 * verify capture, PR comment plate (same DOM grammar as S3). Same frame
 * position each cut: the plate is the match.
 * Kinetic: "One witness, every surface."
 */

const PLATE_W = 1180;
const PLATE_H = 720;
const CUT = 78; // ~1.3s per surface

const PlateShell: React.FC<{children: React.ReactNode; label: string}> = ({
  children,
  label,
}) => (
  <div
    style={{
      width: PLATE_W,
      height: PLATE_H,
      background: color.surface,
      border: `1px solid ${color.hairline}`,
      borderRadius: radius.lg,
      overflow: 'hidden',
      position: 'relative',
    }}
  >
    {children}
    <div
      style={{
        position: 'absolute',
        left: 24,
        top: 20,
        padding: '7px 16px',
        borderRadius: radius.sm,
        background: `${color.canvas}D9`,
        border: `1px solid ${color.hairline}`,
        fontFamily: font.mono,
        fontSize: 21,
        color: color.ink3,
        letterSpacing: '0.06em',
      }}
    >
      {label}
    </div>
  </div>
);

const ReportPlate: React.FC = () => (
  <PlateShell label="argus-reviewer-report/report.html">
    <Img
      src={staticFile('captures/report.png')}
      style={{width: '100%', height: '100%', objectFit: 'cover', objectPosition: 'top'}}
    />
  </PlateShell>
);

const VerifyPlate: React.FC = () => (
  <PlateShell label="argus-reviewer verify --flow">
    <OffthreadVideo
      src={staticFile('captures/verify.mp4')}
      startFrom={430}
      style={{width: '100%', height: '100%', objectFit: 'cover'}}
      muted
    />
  </PlateShell>
);

const CommentPlate: React.FC = () => (
  <PlateShell label="PR comment · acme/shop #42">
    <div style={{padding: '34px 40px', fontFamily: font.mono}}>
      <div
        style={{
          display: 'flex',
          alignItems: 'baseline',
          gap: 16,
          fontFamily: font.grotesk,
        }}
      >
        <span style={{fontSize: 44, fontWeight: 700, color: color.ink}}>Argus:</span>
        <span style={{fontSize: 44, fontWeight: 700, color: color.failed}}>
          ⊘ needs changes
        </span>
      </div>
      <div style={{marginTop: 12, fontSize: 24, color: color.ink2}}>
        2 findings reproduced in src/discount.ts · head a1b2c3d · $0.004210 · 38.1s
      </div>
      {[
        {s: 'failed' as const, lane: 'review', r: '3 findings, 2 reproduced'},
        {s: 'passed' as const, lane: 'flow', r: '4 of 4 journeys, 1 healed'},
        {s: 'inconclusive' as const, lane: 'a0', r: 'agent report is self-reported'},
      ].map((l) => (
        <div
          key={l.lane}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 18,
            padding: '16px 0',
            borderTop: `1px solid ${color.hairline}`,
            fontSize: 26,
            color: color.ink2,
          }}
        >
          <StatusGlyph status={l.s} size={36} />
          <span style={{width: 120, color: color.ink}}>{l.lane}</span>
          <span>{l.r}</span>
        </div>
      ))}
      <div style={{marginTop: 10, fontSize: 23, color: color.ink3}}>
        ◆ 2 bugs · ◈ 1 risk · ○ 0 nits · 1 high-confidence
      </div>
    </div>
  </PlateShell>
);

export const Scene06Surfaces: React.FC = () => {
  const frame = useCurrentFrame();
  const sq = useSquare();
  const idx = Math.min(2, Math.floor(frame / CUT));
  const enterT = frame - idx * CUT;
  const enter = interpolate(enterT, [0, 10], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
    easing: Easing.bezier(...motion.easeOut),
  });
  const push = interpolate(enterT, [0, CUT], [1.0, 1.035]);
  const beatIn = interpolate(frame, [252, 264], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });

  const plates = [<ReportPlate key="r" />, <VerifyPlate key="v" />, <CommentPlate key="c" />];

  return (
    <div style={{position: 'absolute', inset: 0, background: color.canvas}}>
      <div
        style={{
          position: 'absolute',
          left: (1920 - PLATE_W) / 2,
          top: (1080 - PLATE_H) / 2 - 40,
          opacity: enter,
          transform: `scale(${push})`,
        }}
      >
        {plates[idx]}
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
            background: `${color.canvas}E6`,
            padding: '16px 32px',
            borderRadius: radius.md,
            opacity: beatIn,
          }}
        >
          <KineticType
            text="One witness, every surface."
            delay={258}
            size={sq.beatFont(72)}
            staggerMs={45}
          />
        </div>
      </div>
    </div>
  );
};
