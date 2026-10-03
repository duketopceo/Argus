import React from 'react';
import {
  Easing,
  interpolate,
  useCurrentFrame,
} from 'remotion';
import {EyeToStatus, StatusGlyph} from '../../../brands/argus/EyeMark';
import {UIZoom} from '../../../core/UIZoom';
import {KineticType} from '../../../core/KineticType';
import {useSquare} from '../../../core/Stage';
import {
  color,
  font,
  motion,
  radius,
  statusColor,
  StatusName,
} from '../../../brands/argus/tokens';

/**
 * Scene 03 — Lane table (480f @60 = 8s).
 * The PR comment rebuilt as a DOM plate — real strings from
 * tests/goldens/comment/mixed-four-lane.md. Camera dollies into the lane
 * table; each lane's eye scans → blinks → resolves to its state.
 * a0's inconclusive eye gets the cobalt emphasis ring — the one primary
 * accent moment in the film (spec: accent on mark + one moment only).
 */

type Lane = {
  status: StatusName;
  name: string;
  result: string;
  proof: string;
  spend: string;
  delay: number;
};

const LANES: Lane[] = [
  {
    status: 'failed',
    name: 'review',
    result: '3 findings, 2 reproduced',
    proof: '▰▰▰▰ reproduced',
    spend: '$0.003100',
    delay: 62,
  },
  {
    status: 'passed',
    name: 'flow',
    result: '4 of 4 journeys, 1 healed',
    proof: '▰▰▰▱ exercised',
    spend: '$0.001110',
    delay: 140,
  },
  {
    status: 'skipped',
    name: 'app',
    result: 'not selected',
    proof: '',
    spend: '',
    delay: 208,
  },
  {
    status: 'inconclusive',
    name: 'a0',
    result: 'agent report is self-reported',
    proof: '▰▱▱▱ suspected',
    spend: 'unmetered',
    delay: 282,
  },
];

const CARD_W = 1420;
const CARD_H = 640;
const ROW_H = 76;

const AccentRing: React.FC<{delay: number; size: number}> = ({
  delay,
  size,
}) => {
  const frame = useCurrentFrame() - delay;
  const r = size / 2 + 7;
  const len = 2 * Math.PI * r;
  const draw = interpolate(frame, [0, 18], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
    easing: Easing.bezier(...motion.easeOut),
  });
  return (
    <svg
      width={size + 14}
      height={size + 14}
      viewBox={`0 0 ${size + 14} ${size + 14}`}
      style={{position: 'absolute', left: -7, top: -7, pointerEvents: 'none'}}
    >
      <circle
        cx={r + 7}
        cy={r + 7}
        r={r}
        fill="none"
        stroke={color.accent}
        strokeWidth={2.2}
        strokeDasharray={len}
        strokeDashoffset={len * (1 - draw)}
        transform={`rotate(-90 ${r + 7} ${r + 7})`}
      />
    </svg>
  );
};

const LaneRow: React.FC<{lane: Lane}> = ({lane}) => {
  const frame = useCurrentFrame();
  const local = frame - lane.delay;
  const textInk = interpolate(local, [0, 24], [0.35, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });
  const dim = lane.status === 'skipped';
  const isAccent = lane.status === 'inconclusive';
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: '300px 150px 1fr 280px 170px',
        alignItems: 'center',
        height: ROW_H,
        borderTop: `1px solid ${color.hairline}`,
        opacity: dim ? 0.55 : textInk,
        fontFamily: font.mono,
        fontSize: 30,
        color: color.ink2,
      }}
    >
      <span
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 12,
          position: 'relative',
          whiteSpace: 'nowrap',
        }}
      >
        <EyeToStatus
          size={44}
          status={lane.status}
          delay={lane.delay}
          scanMs={lane.status === 'skipped' ? 240 : 460}
        />
        {isAccent && <AccentRing delay={lane.delay + 62} size={44} />}
        <span
          style={{
            fontSize: 24,
            color:
              local > 66 ? statusColor[lane.status] : color.ink3,
          }}
        >
          {lane.status}
        </span>
      </span>
      <span style={{color: color.ink}}>{lane.name}</span>
      <span
        style={{
          color: dim ? color.ink3 : color.ink2,
          fontSize: 27,
          whiteSpace: 'nowrap',
          paddingRight: 20,
        }}
      >
        {lane.result}
      </span>
      <span
        style={{
          color: color.ink3,
          fontSize: 26,
          whiteSpace: 'nowrap',
          paddingLeft: 8,
        }}
      >
        {lane.proof}
      </span>
      <span style={{color: color.ink2, textAlign: 'right'}}>{lane.spend}</span>
    </div>
  );
};

const CommentCard: React.FC = () => {
  const frame = useCurrentFrame();
  const enter = interpolate(frame, [0, 18], [0, 1], {
    extrapolateRight: 'clamp',
    easing: Easing.bezier(...motion.easeOut),
  });
  const headFail = interpolate(frame, [34, 48], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });
  return (
    <div
      style={{
        position: 'absolute',
        left: (1920 - CARD_W) / 2,
        top: 170,
        width: CARD_W,
        height: CARD_H,
        background: color.surface,
        border: `1px solid ${color.hairline}`,
        borderRadius: radius.lg,
        padding: '34px 40px 30px',
        opacity: enter,
        transform: `scale(${interpolate(enter, [0, 1], [0.94, 1])})`,
        transformOrigin: 'center 30%',
      }}
    >
      {/* header — real golden string */}
      <div
        style={{
          display: 'flex',
          alignItems: 'baseline',
          gap: 18,
          fontFamily: font.grotesk,
        }}
      >
        <span
          style={{fontSize: 48, fontWeight: 700, color: color.ink}}
        >
          Argus:
        </span>
        <span
          style={{
            fontSize: 48,
            fontWeight: 700,
            color: statusColor.failed,
            opacity: headFail,
            transform: `translateY(${interpolate(headFail, [0, 1], [10, 0])}px)`,
          }}
        >
          ⊘ needs changes
        </span>
      </div>
      <div
        style={{
          marginTop: 14,
          fontFamily: font.mono,
          fontSize: 25,
          color: color.ink2,
          whiteSpace: 'nowrap',
        }}
      >
        <span style={{color: color.ink}}>2 findings reproduced</span>
        {' in '}
        <span style={{color: color.ink}}>src/discount.ts</span>
        {' · head '}
        <span style={{color: color.ink}}>a1b2c3d</span>
        {' · $0.004210 · 38.1s'}
      </div>
      {/* lane table header */}
      <div
        style={{
          marginTop: 30,
          display: 'grid',
          gridTemplateColumns: '300px 150px 1fr 280px 170px',
          height: 56,
          alignItems: 'end',
          paddingBottom: 12,
          fontFamily: font.mono,
          fontSize: 21,
          color: color.ink3,
          textTransform: 'uppercase',
          letterSpacing: '0.08em',
        }}
      >
        <span>Status</span>
        <span>Lane</span>
        <span>Result</span>
        <span>Proof</span>
        <span style={{textAlign: 'right'}}>Spend</span>
      </div>
      {LANES.map((lane) => (
        <LaneRow key={lane.name} lane={lane} />
      ))}
      {/* severity footer — real golden string */}
      <div
        style={{
          marginTop: 22,
          fontFamily: font.mono,
          fontSize: 22,
          color: color.ink3,
          whiteSpace: 'nowrap',
        }}
      >
        <span style={{color: statusColor.failed}}>◆ 2 bugs</span>
        {' · '}
        <span style={{color: statusColor.inconclusive}}>◈ 1 risk</span>
        {' · ○ 0 nits · '}
        <span style={{color: color.ink2}}>1 high-confidence</span>
        {' · 1 suggestion ready to commit'}
      </div>
    </div>
  );
};

export const Scene03Lanes: React.FC = () => {
  const frame = useCurrentFrame();
  // Camera: settle on whole card → push down the table rows as eyes fire →
  // ease back for the type beat. Card top 170 + pad 34 + header ~58 +
  // summary ~45 + table header ~86 → first row center ≈ 431.
  const y0 = 431;
  const sq = useSquare();
  const beatIn = interpolate(frame, [368, 380], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });
  return (
    <div style={{position: 'absolute', inset: 0, background: color.canvas}}>
      <UIZoom
        width={1920}
        height={1080}
        keys={[
          {at: 0, x: 960, y: 500, scale: 1.12},
          {at: 34, x: 960, y: 500, scale: 1.12},
          {at: 62, x: 800, y: y0, scale: 1.3},
          {at: 140, x: 800, y: y0 + ROW_H, scale: 1.3},
          {at: 208, x: 800, y: y0 + ROW_H * 2, scale: 1.3},
          {at: 282, x: 800, y: y0 + ROW_H * 3, scale: 1.36},
          {at: 356, x: 960, y: 450, scale: 1.02},
          {at: 480, x: 960, y: 450, scale: 1.05},
        ]}
      >
        <div style={{position: 'absolute', inset: 0, background: color.canvas}}>
          <CommentCard />
        </div>
      </UIZoom>
      {/* type beat — lands as camera settles back */}
      <div
        style={{
          position: 'absolute',
          left: 0,
          right: 0,
          bottom: sq.beatBottom(172),
          display: 'flex',
          justifyContent: 'center',
        }}
      >
        <div
          style={{
            background: `${color.canvas}E6`,
            padding: '18px 34px',
            borderRadius: radius.md,
            opacity: beatIn,
          }}
        >
          <KineticType
            text="Four lanes. Honest when unsure."
            delay={372}
            size={sq.beatFont(72)}
            staggerMs={45}
          />
        </div>
      </div>
    </div>
  );
};
