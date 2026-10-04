import React from 'react';
import {
  Easing,
  Img,
  interpolate,
  staticFile,
  useCurrentFrame,
} from 'remotion';
import {EyeOpen} from '../../../brands/argus/EyeMark';
import {MonoLine} from '../../../core/KineticType';
import {color, font, motion} from '../../../brands/argus/tokens';

/**
 * Scene 07 — End card (240f = 4s, holds ≥2s static).
 * The mark draws open at center, slides left and resolves beside the real
 * wordmark as it wipes in; the install line types underneath; repo URL last.
 * Cobalt mark + ink wordmark — accent discipline holds to the last frame.
 */
export const Scene07EndCard: React.FC = () => {
  const frame = useCurrentFrame();

  // mark settles left ~f40; wordmark wipes 40–62; lines type after.
  const slide = interpolate(frame, [36, 56], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
    easing: Easing.bezier(...motion.easeInOut),
  });
  const markX = interpolate(slide, [0, 1], [291, 0]);
  const markScale = interpolate(slide, [0, 1], [1, 0.52]);
  const wordClip = interpolate(frame, [44, 66], [0, 100], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
    easing: Easing.bezier(...motion.easeOut),
  });
  const urlIn = interpolate(frame, [96, 110], [0, 1], {
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
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 24,
          transform: 'translateY(-70px)',
        }}
      >
        <div style={{transform: `translateX(${markX}px)`}}>
          <div
            style={{transform: `scale(${markScale})`, transformOrigin: 'center'}}
          >
            <EyeOpen size={210} delay={2} tint={color.accent} />
          </div>
        </div>
        <div
          style={{
            overflow: 'hidden',
            clipPath: `inset(0 ${100 - wordClip}% 0 0)`,
          }}
        >
          <Img
            src={staticFile('brand/wordmark-dark.svg')}
            style={{height: 150, display: 'block'}}
          />
        </div>
      </div>
      <div
        style={{
          marginTop: 20,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          gap: 20,
        }}
      >
        <MonoLine
          text="npx argus-reviewer init"
          delay={64}
          size={40}
          ink={color.ink}
          weight={600}
        />
        <div
          style={{
            fontFamily: font.mono,
            fontSize: 26,
            color: color.ink3,
            opacity: urlIn,
          }}
        >
          github.com/duketopceo/Argus · self-hosted · BYOK
        </div>
      </div>
    </div>
  );
};
