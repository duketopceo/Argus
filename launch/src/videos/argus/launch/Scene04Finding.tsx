import React from 'react';
import {Easing, interpolate, useCurrentFrame} from 'remotion';
import {UIZoom} from '../../../core/UIZoom';
import {SynthCursor} from '../../../core/SynthCursor';
import {KineticType} from '../../../core/KineticType';
import {
  color,
  font,
  motion,
  radius,
  statusColor,
} from '../../../brands/argus/tokens';
import {StatusGlyph} from '../../../brands/argus/EyeMark';
import {useSquare} from '../../../core/Stage';

/**
 * Scene 04 — Inline finding (420f = 7s).
 * A diff line gets bracket-locked, then the finding card deals in under it,
 * then the cursor hovers the provenance chip which opens to show the real
 * model + probe path. All strings from mixed-four-lane.json.
 * Kinetic: "Every finding cites its source."
 */

const BUGGY = '  for (let i = 0; i <= len(events); i++) {';
const FIXED = '  for (let i = 0; i < events.length; i++) {';

const Bracket: React.FC<{delay: number; w: number; h: number}> = ({
  delay,
  w,
  h,
}) => {
  const frame = useCurrentFrame() - delay;
  const draw = interpolate(frame, [0, 12], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
    easing: Easing.bezier(...motion.easeOut),
  });
  const arm = 22 * draw;
  const c = color.failed;
  const s: React.CSSProperties = {position: 'absolute', width: arm, height: arm, borderColor: c, borderStyle: 'solid', borderWidth: 0};
  return (
    <div style={{position: 'absolute', left: -16, top: -8, width: w + 32, height: h + 16, pointerEvents: 'none'}}>
      <span style={{...s, left: 0, top: 0, borderLeftWidth: 3, borderTopWidth: 3}} />
      <span style={{...s, right: 0, top: 0, borderRightWidth: 3, borderTopWidth: 3}} />
      <span style={{...s, left: 0, bottom: 0, borderLeftWidth: 3, borderBottomWidth: 3}} />
      <span style={{...s, right: 0, bottom: 0, borderRightWidth: 3, borderBottomWidth: 3}} />
    </div>
  );
};

const Stage: React.FC = () => {
  const frame = useCurrentFrame();
  // Card deals in after the bracket locks the line (bracket done ~f64).
  const cardIn = interpolate(frame, [78, 96], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
    easing: Easing.bezier(...motion.easeOut),
  });
  // Provenance chip opens when the cursor arrives (~f210).
  const provOpen = interpolate(frame, [214, 232], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
    easing: Easing.bezier(...motion.easeOut),
  });
  const provGlow = interpolate(frame, [206, 214, 240], [0, 1, 0.55], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });

  return (
    <div style={{position: 'absolute', inset: 0}}>
      {/* diff plate */}
      <div
        style={{
          position: 'absolute',
          left: 340,
          top: 150,
          width: 1240,
          background: color.surface,
          border: `1px solid ${color.hairline}`,
          borderRadius: radius.lg,
          overflow: 'hidden',
          fontFamily: font.mono,
        }}
      >
        <div
          style={{
            padding: '16px 26px',
            fontSize: 26,
            color: color.ink2,
            borderBottom: `1px solid ${color.hairline}`,
          }}
        >
          src/discount.ts
        </div>
        <div style={{padding: '14px 0', fontSize: 27, lineHeight: 1.85}}>
          {[
            {n: 17, t: '  …', tone: 'ctx'},
            {n: 18, t: '  …', tone: 'ctx'},
          ].map((l) => (
            <div key={l.n} style={{display: 'flex', color: color.ink3, padding: '0 26px'}}>
              <span style={{width: 52, textAlign: 'right', marginRight: 22, opacity: 0.55}}>{l.n}</span>
              <span>{l.t}</span>
            </div>
          ))}
          {/* the anchored line — buggy expr per fixture message */}
          <div
            style={{
              position: 'relative',
              display: 'flex',
              padding: '0 26px',
              background: color.failedTint,
            }}
          >
            <span style={{width: 52, textAlign: 'right', marginRight: 22, color: statusColor.failed, opacity: 0.8}}>19</span>
            <span style={{color: color.ink}}>
              <span style={{color: statusColor.failed}}>- </span>
              {BUGGY.trimStart()}
            </span>
            <Bracket delay={36} w={1188} h={50} />
          </div>
          {[
            {n: 20, t: '  …', tone: 'ctx'},
          ].map((l) => (
            <div key={l.n} style={{display: 'flex', color: color.ink3, padding: '0 26px'}}>
              <span style={{width: 52, textAlign: 'right', marginRight: 22, opacity: 0.55}}>{l.n}</span>
              <span>{l.t}</span>
            </div>
          ))}
        </div>
      </div>

      {/* finding card — pinned to the anchored line */}
      <div
        style={{
          position: 'absolute',
          left: 380,
          top: 468,
          width: 1160,
          background: color.raised,
          border: `1px solid ${color.hairline}`,
          borderRadius: radius.lg,
          padding: '26px 30px',
          opacity: cardIn,
          transform: `translateY(${interpolate(cardIn, [0, 1], [26, 0])}px)`,
          fontFamily: font.mono,
        }}
      >
        <div style={{display: 'flex', alignItems: 'center', gap: 22, fontSize: 25}}>
          <span style={{display: 'inline-flex', alignItems: 'center', gap: 10, color: statusColor.failed}}>
            <StatusGlyph status="failed" size={30} />
            <b>bug</b>
          </span>
          <span style={{color: color.ink3}}>correctness</span>
          <span style={{color: color.ink3}}>src/discount.ts:19</span>
          <span style={{marginLeft: 'auto', color: color.ink2}}>▰▰▰▰ reproduced</span>
        </div>
        <div style={{marginTop: 18, fontSize: 30, color: color.ink, lineHeight: 1.4}}>
          Loop bound <span style={{color: statusColor.failed}}>i &lt;= len(events)</span> reads one past the end.
        </div>
        <div style={{marginTop: 8, fontSize: 24, color: color.ink3}}>
          evidence: probe fails on head, passes on base
        </div>
        <div
          style={{
            marginTop: 18,
            padding: '14px 20px',
            background: color.passedTint,
            borderRadius: radius.sm,
            fontSize: 26,
            color: color.passed,
          }}
        >
          + {FIXED.trimStart()}
        </div>
        {/* provenance chip — cursor hovers it open */}
        <div
          style={{
            marginTop: 20,
            display: 'inline-block',
            padding: '10px 18px',
            borderRadius: radius.sm,
            border: `1px solid ${provGlow > 0.2 ? color.accent : color.controlBorder}`,
            background: provGlow > 0.2 ? color.accentTint : 'transparent',
            fontSize: 23,
            color: color.ink2,
          }}
        >
          provenance
          <span
            style={{
              display: 'inline-block',
              overflow: 'hidden',
              verticalAlign: 'bottom',
              maxWidth: interpolate(provOpen, [0, 1], [0, 1400]),
              opacity: provOpen,
              whiteSpace: 'nowrap',
            }}
          >
            {' — '}
            <span style={{color: color.ink}}>deepseek/deepseek-v4.1-flash</span>
            {' · p 0.94 · '}
            <span style={{color: color.ink3}}>tests/argus-probes/discount-bound.test.ts</span>
          </span>
        </div>
      </div>

      <SynthCursor
        keys={[
          {at: 0, x: 1560, y: 300},
          {at: 96, x: 1240, y: 330, click: true},
          {at: 150, x: 1240, y: 330},
          {at: 212, x: 505, y: 813},
          {at: 300, x: 505, y: 813},
        ]}
      />
    </div>
  );
};

export const Scene04Finding: React.FC = () => {
  const frame = useCurrentFrame();
  const sq = useSquare();
  const beatIn = interpolate(frame, [330, 342], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });
  return (
    <div style={{position: 'absolute', inset: 0, background: color.canvas}}>
      <UIZoom
        width={1920}
        height={1080}
        keys={[
          {at: 0, x: 960, y: 480, scale: 1.0},
          {at: 30, x: 960, y: 330, scale: 1.28},
          {at: 78, x: 960, y: 330, scale: 1.28},
          {at: 132, x: 960, y: 640, scale: 1.34},
          {at: 212, x: 700, y: 800, scale: 1.55},
          {at: 318, x: 960, y: 540, scale: 1.02},
          {at: 420, x: 960, y: 540, scale: 1.05},
        ]}
      >
        <Stage />
      </UIZoom>
      <div
        style={{
          position: 'absolute',
          left: 0,
          right: 0,
          bottom: sq.beatBottom(170),
          display: 'flex',
          justifyContent: 'center',
        }}
      >
        <div style={{background: `${color.canvas}E6`, padding: '16px 32px', borderRadius: radius.md, opacity: beatIn}}>
          <KineticType text="Every finding cites its source." delay={334} size={sq.beatFont(70)} staggerMs={45} />
        </div>
      </div>
    </div>
  );
};
