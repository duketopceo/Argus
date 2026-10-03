import React from 'react';
import {OffthreadVideo, staticFile} from 'remotion';
import {color, radius} from '../brands/argus/tokens';

/**
 * Framed capture plate — window chrome around a real VHS/OffthreadVideo
 * capture. The plate is Ocellus chrome; the content is untouched footage.
 */
export const TerminalPlate: React.FC<{
  src: string;
  startFrom?: number;
  endAt?: number;
  width: number;
  height: number;
}> = ({src, startFrom, endAt, width, height}) => {
  return (
    <div
      style={{
        width,
        background: color.surfaceSunk,
        border: `1px solid ${color.hairline}`,
        borderRadius: radius.lg,
        overflow: 'hidden',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          padding: '14px 20px',
          borderBottom: `1px solid ${color.hairline}`,
          background: color.surface,
        }}
      >
        {[color.ink3, color.ink3, color.ink3].map((c, i) => (
          <span
            key={i}
            style={{
              width: 11,
              height: 11,
              borderRadius: '50%',
              border: `1.5px solid ${c}`,
              opacity: 0.5,
            }}
          />
        ))}
      </div>
      <OffthreadVideo
        src={staticFile(src)}
        startFrom={startFrom}
        endAt={endAt}
        style={{width: '100%', display: 'block'}}
        muted
      />
    </div>
  );
};
