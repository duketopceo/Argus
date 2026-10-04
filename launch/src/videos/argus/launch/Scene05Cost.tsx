import React from 'react';
import {Easing, interpolate, useCurrentFrame} from 'remotion';
import {KineticType} from '../../../core/KineticType';
import {useSquare} from '../../../core/Stage';
import {color, font, motion, radius} from '../../../brands/argus/tokens';

/**
 * Scene 05 — Cost ledger (480f = 8s).
 * The spend ledger deals in row by row, the total tallies up via digit
 * odometer, then `argus-reviewer run` fires, the cache line lands, and every
 * figure rolls down to $0.000000. All figures from mixed-four-lane.json and
 * the real run-cache-hit capture.
 * Kinetic: "Re-reviews cost nothing."
 */

/** One odometer digit column: rolls forward from `from` to `to`, wrapping
 *  through 9 → 0 so a fall to zero reads as a long spin down. */
const REEL = '01234567890123456789';
const Digit: React.FC<{
  from: string;
  to: string;
  t0: number;
  span?: number;
  size: number;
  ink?: string;
}> = ({from, to, t0, span = 34, size, ink = color.ink}) => {
  const frame = useCurrentFrame();
  const isDigit = to >= '0' && to <= '9';
  const p = interpolate(frame - t0, [0, span], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
    easing: Easing.bezier(0.16, 0, 0.1, 1),
  });
  const ch = Math.round(1.18 * size);
  if (!isDigit) {
    return (
      <span style={{display: 'inline-block', width: size * 0.62, color: ink, opacity: p}}>
        {to}
      </span>
    );
  }
  const f = from >= '0' && from <= '9' ? Number(from) : 0;
  const t = Number(to);
  const steps = (t - f + 10) % 10 || (f !== t ? 10 : 0);
  const idx = f + p * steps; // rests on `from` at p=0, lands on `to` at p=1
  return (
    <span
      style={{
        display: 'inline-block',
        width: size * 0.62,
        height: ch,
        overflow: 'hidden',
        color: ink,
      }}
    >
      <span
        style={{
          display: 'flex',
          flexDirection: 'column',
          transform: `translateY(${-p * idx * ch}px)`,
        }}
      >
        {REEL.split('').map((d, i) => (
          <span key={i} style={{height: ch, lineHeight: `${ch}px`}}>
            {d}
          </span>
        ))}
      </span>
    </span>
  );
};

const Odometer: React.FC<{
  value: string;
  from?: string;
  t0: number;
  span?: number;
  size: number;
  ink?: string;
}> = ({value, from, t0, span = 34, size, ink}) => {
  const src = from ?? '0'.repeat(value.length);
  return (
    <span
      style={{
        display: 'inline-flex',
        fontFamily: font.mono,
        fontSize: size,
        fontWeight: 600,
        fontVariantNumeric: 'tabular-nums',
      }}
    >
      {value.split('').map((c, i) => (
        <Digit
          key={i}
          from={src[i] ?? '0'}
          to={c}
          t0={t0 + i * 3}
          span={span}
          size={size}
          ink={ink}
        />
      ))}
    </span>
  );
};

const LEDGER = [
  {lane: 'review', model: 'deepseek/deepseek-v4.1-flash', calls: '4', tokens: '4200', spend: '$0.003100'},
  {lane: 'flow', model: 'google/gemini-2.5-flash-lite', calls: '3', tokens: '2600', spend: '$0.001110'},
  {lane: 'a0', model: '', calls: '0', tokens: '0', spend: 'unmetered'},
];

const LedgerRow: React.FC<{row: (typeof LEDGER)[0]; delay: number; zeroed: boolean}> = ({
  row,
  delay,
  zeroed,
}) => {
  const frame = useCurrentFrame();
  const enter = interpolate(frame - delay, [0, 14], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
    easing: Easing.bezier(...motion.easeOut),
  });
  const isZero = row.spend.startsWith('$');
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: '140px 1fr 140px 160px 280px',
        alignItems: 'center',
        height: 72,
        borderTop: `1px solid ${color.hairline}`,
        opacity: enter,
        transform: `translateY(${interpolate(enter, [0, 1], [14, 0])}px)`,
        fontFamily: font.mono,
        fontSize: 27,
      }}
    >
      <span style={{color: color.ink}}>{row.lane}</span>
      <span style={{color: color.ink3, fontSize: 21, whiteSpace: 'nowrap'}}>{row.model}</span>
      <span style={{color: color.ink2, textAlign: 'right'}}>{row.calls}</span>
      <span style={{color: color.ink2, textAlign: 'right'}}>{row.tokens}</span>
      <span style={{textAlign: 'right'}}>
        {isZero ? (
          <Odometer
            value={zeroed ? '$0.000000' : row.spend}
            from={zeroed ? row.spend : undefined}
            t0={zeroed ? 208 : delay + 8}
            span={zeroed ? 42 : 34}
            size={30}
            ink={zeroed ? color.passed : color.ink}
          />
        ) : (
          <span style={{color: color.ink3}}>{row.spend}</span>
        )}
      </span>
    </div>
  );
};

export const Scene05Cost: React.FC = () => {
  const frame = useCurrentFrame();
  const sq = useSquare();
  const cardIn = interpolate(frame, [0, 18], [0, 1], {
    extrapolateRight: 'clamp',
    easing: Easing.bezier(...motion.easeOut),
  });
  const rerun = interpolate(frame, [176, 190], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });
  // digits roll to zero across 210–290
  const zeroed = frame >= 208;
  const zeroFlash = interpolate(frame, [280, 300], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });
  const beatIn = interpolate(frame, [368, 380], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });

  return (
    <div style={{position: 'absolute', inset: 0, background: color.canvas}}>
      <div
        style={{
          position: 'absolute',
          left: 330,
          top: 130,
          width: 1260,
          background: color.surface,
          border: `1px solid ${color.hairline}`,
          borderRadius: radius.lg,
          padding: '34px 40px',
          opacity: cardIn,
          transform: `scale(${interpolate(cardIn, [0, 1], [0.95, 1])})`,
        }}
      >
        <div
          style={{
            fontFamily: font.grotesk,
            fontSize: 40,
            fontWeight: 700,
            color: color.ink,
            marginBottom: 8,
          }}
        >
          Spend ledger
        </div>
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: '140px 1fr 140px 160px 280px',
            paddingBottom: 12,
            fontFamily: font.mono,
            fontSize: 20,
            color: color.ink3,
            textTransform: 'uppercase',
            letterSpacing: '0.08em',
          }}
        >
          <span>Lane</span><span>Model</span>
          <span style={{textAlign: 'right'}}>Calls</span>
          <span style={{textAlign: 'right'}}>Tokens</span>
          <span style={{textAlign: 'right'}}>Spend</span>
        </div>
        {LEDGER.map((row, i) => (
          <LedgerRow key={row.lane} row={row} delay={34 + i * 22} zeroed={zeroed} />
        ))}
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'baseline',
            borderTop: `1px solid ${color.hairline}`,
            marginTop: 10,
            paddingTop: 24,
            fontFamily: font.mono,
          }}
        >
          <span style={{fontSize: 28, color: color.ink2}}>Total · 7 calls · 6800 tokens</span>
          <Odometer
            value={zeroed ? '$0.000000' : '$0.004210'}
            from={zeroed ? '$0.004210' : undefined}
            t0={zeroed ? 208 : 112}
            span={zeroed ? 56 : 46}
            size={54}
            ink={zeroed ? color.passed : color.ink}
          />
        </div>
      </div>

      {/* re-run strip */}
      <div
        style={{
          position: 'absolute',
          left: 330,
          top: 660,
          width: 1260,
          fontFamily: font.mono,
          opacity: rerun,
        }}
      >
        <div style={{fontSize: 28, color: color.ink2}}>
          <span style={{color: color.accent}}>$</span> argus-reviewer run
        </div>
        <div
          style={{
            marginTop: 12,
            fontSize: 24,
            color: color.ink3,
            opacity: interpolate(frame, [196, 208], [0, 1], {
              extrapolateLeft: 'clamp',
              extrapolateRight: 'clamp',
            }),
          }}
        >
          fingerprint cache: 3 hits · 1 miss · 1 heal
        </div>
        <div
          style={{
            marginTop: 16,
            fontSize: 24,
            color: color.passed,
            opacity: zeroFlash,
            whiteSpace: 'nowrap',
          }}
        >
          total $0.000000 of $1.00 budget · report argus-reviewer-report/run.json
        </div>
      </div>

      <div
        style={{
          position: 'absolute',
          left: 0,
          right: 0,
          bottom: sq.beatBottom(140),
          display: 'flex',
          justifyContent: 'center',
        }}
      >
        <div style={{background: `${color.canvas}E6`, padding: '16px 32px', borderRadius: radius.md, opacity: beatIn}}>
          <KineticType text="Re-reviews cost nothing." delay={372} size={sq.beatFont(76)} staggerMs={50} />
        </div>
      </div>
    </div>
  );
};
