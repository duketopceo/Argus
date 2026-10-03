import React from 'react';
import {Sequence} from 'remotion';
import {StageFit} from '../../../core/Stage';
import {LoopReadme} from './LoopReadme';
import {Scene01Hook} from './Scene01Hook';
import {Scene02Terminal} from './Scene02Terminal';
import {Scene03Lanes} from './Scene03Lanes';
import {Scene04Finding} from './Scene04Finding';
import {Scene05Cost} from './Scene05Cost';
import {Scene06Surfaces} from './Scene06Surfaces';
import {Scene07EndCard} from './Scene07EndCard';
import {Fonts} from '../../../core/Fonts';
import {color} from '../../../brands/argus/tokens';

/**
 * 'The witness' — 40s X launch film per docs/design/research
 * craft-and-launch-research.md §B.5. Silent-first (Q11: CC0 foley only).
 * All timings in frames @60.
 */
export const ArgusLaunch: React.FC = () => {
  return (
    <div style={{position: 'absolute', inset: 0, background: color.canvas}}>
      <Fonts />
      <Sequence durationInFrames={150} name="S1 hook">
        <Scene01Hook />
      </Sequence>
      <Sequence from={150} durationInFrames={270} name="S2 terminal">
        <Scene02Terminal />
      </Sequence>
      <Sequence from={420} durationInFrames={480} name="S3 lanes">
        <Scene03Lanes />
      </Sequence>
      <Sequence from={900} durationInFrames={420} name="S4 finding">
        <Scene04Finding />
      </Sequence>
      <Sequence from={1320} durationInFrames={480} name="S5 cost">
        <Scene05Cost />
      </Sequence>
      <Sequence from={1800} durationInFrames={360} name="S6 surfaces">
        <Scene06Surfaces />
      </Sequence>
      <Sequence from={2160} durationInFrames={240} name="S7 end card">
        <Scene07EndCard />
      </Sequence>
    </div>
  );
};

/**
 * 1:1 feed cut — same scenes fitted (scaled, not cropped) onto the square
 * canvas; type beats re-size via useSquare() to stay >=48px in output.
 */
export const ArgusLaunchSquare: React.FC = () => {
  return (
    <div style={{position: 'absolute', inset: 0, background: color.canvas}}>
      <Fonts />
      <Sequence durationInFrames={150} name="S1 hook">
        <StageFit><Scene01Hook /></StageFit>
      </Sequence>
      <Sequence from={150} durationInFrames={270} name="S2 terminal">
        <StageFit><Scene02Terminal /></StageFit>
      </Sequence>
      <Sequence from={420} durationInFrames={480} name="S3 lanes">
        <StageFit><Scene03Lanes /></StageFit>
      </Sequence>
      <Sequence from={900} durationInFrames={420} name="S4 finding">
        <StageFit><Scene04Finding /></StageFit>
      </Sequence>
      <Sequence from={1320} durationInFrames={480} name="S5 cost">
        <StageFit><Scene05Cost /></StageFit>
      </Sequence>
      <Sequence from={1800} durationInFrames={360} name="S6 surfaces">
        <StageFit><Scene06Surfaces /></StageFit>
      </Sequence>
      <Sequence from={2160} durationInFrames={240} name="S7 end card">
        <StageFit><Scene07EndCard /></StageFit>
      </Sequence>
    </div>
  );
};

/**
 * README loop — 7.5s silent loop for docs/changelog (finish.sh exports the
 * 960px MP4 + gifski GIF).
 */
export const ArgusReadmeLoop: React.FC = () => {
  return (
    <div style={{position: 'absolute', inset: 0, background: color.canvas}}>
      <Fonts />
      <LoopReadme />
    </div>
  );
};

/**
 * Prototype assembly for the taste gate — hook + lanes only.
 * Superseded by ArgusLaunch for the full film.
 */
export const ArgusLaunchProto: React.FC = () => {
  return (
    <div style={{position: 'absolute', inset: 0, background: color.canvas}}>
      <Fonts />
      <Sequence durationInFrames={150} name="S1 hook">
        <Scene01Hook />
      </Sequence>
      <Sequence from={150} durationInFrames={480} name="S3 lanes">
        <Scene03Lanes />
      </Sequence>
    </div>
  );
};
