import React from 'react';
import {useVideoConfig} from 'remotion';

// Aspect-aware stage: scenes are authored in 1920x1080 space. For the 1:1 cut
// the whole scene is fitted (scaled, never cropped) into the square canvas on
// the same canvas color, and overlay type beats are bumped so they stay legible
// (>=48px in output) per the QC gate.
export const useSquare = () => {
  const {width, height} = useVideoConfig();
  const square = width === height;
  return {
    square,
    k: width / 1920,
    // Overlay text: scale up inside the shrunk stage so output stays >=48px.
    beatFont: (px: number) =>
      square ? Math.min(96, Math.max(86, Math.round(px * 1.4))) : px,
    beatBottom: (px: number) => (square ? 300 : px),
  };
};

export const StageFit: React.FC<{children: React.ReactNode}> = ({children}) => {
  const {width, height} = useVideoConfig();
  if (width === 1920 && height === 1080) {
    return <>{children}</>;
  }
  const k = width / 1920;
  return (
    <div
      style={{
        position: 'absolute',
        left: (width - 1920) / 2,
        top: (height - 1080) / 2,
        width: 1920,
        height: 1080,
        transform: `scale(${k})`,
        transformOrigin: 'center',
      }}
    >
      {children}
    </div>
  );
};
