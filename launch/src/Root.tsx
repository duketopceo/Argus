import React from 'react';
import {Composition} from 'remotion';
import {
  ArgusLaunch,
  ArgusLaunchProto,
  ArgusLaunchSquare,
  ArgusReadmeLoop,
} from './videos/argus/launch';

export const Root: React.FC = () => {
  return (
    <>
      <Composition
        id="ArgusLaunch"
        component={ArgusLaunch}
        durationInFrames={2400}
        fps={60}
        width={1920}
        height={1080}
      />
      <Composition
        id="ArgusLaunchSquare"
        component={ArgusLaunchSquare}
        durationInFrames={2400}
        fps={60}
        width={1080}
        height={1080}
      />
      <Composition
        id="ArgusReadmeLoop"
        component={ArgusReadmeLoop}
        durationInFrames={450}
        fps={60}
        width={1920}
        height={1080}
      />
      <Composition
        id="ArgusLaunchProto"
        component={ArgusLaunchProto}
        durationInFrames={630}
        fps={60}
        width={1920}
        height={1080}
      />
    </>
  );
};
