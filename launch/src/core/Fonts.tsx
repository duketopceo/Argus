import React, {useEffect} from 'react';
import {continueRender, delayRender, staticFile} from 'remotion';

/**
 * Loads the Ocellus brand faces (subset woff2 in public/fonts) and blocks
 * the render until document.fonts reports them usable — no FOUT mid-film.
 */
export const Fonts: React.FC = () => {
  const [handle] = React.useState(() => delayRender('Loading brand fonts'));
  useEffect(() => {
    const css = `
      @font-face {
        font-family: 'Schibsted Grotesk';
        src: url('${staticFile('fonts/schibsted-grotesk-var.woff2')}') format('woff2');
        font-weight: 100 900;
        font-display: block;
      }
      @font-face {
        font-family: 'Martian Mono';
        src: url('${staticFile('fonts/martian-mono-var.woff2')}') format('woff2');
        font-weight: 100 800;
        font-display: block;
      }
      @font-face {
        font-family: 'Argus Glyphs';
        src: url('${staticFile('fonts/argus-glyphs.woff2')}') format('woff2');
        font-display: block;
      }
    `;
    const style = document.createElement('style');
    style.textContent = css;
    document.head.appendChild(style);
    document.fonts.ready.then(() => continueRender(handle));
    return () => {
      document.head.removeChild(style);
    };
  }, [handle]);
  return null;
};
