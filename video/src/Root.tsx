import { Composition } from 'remotion';
import { Launch, END, TITLE } from './Launch';
import track from './track.json';

export const Root = () => (
  <Composition id="Launch" component={Launch} width={1920} height={1080} fps={30} durationInFrames={TITLE + track.n + END} />
);
