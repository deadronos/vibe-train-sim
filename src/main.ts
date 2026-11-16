// Entry point. Importing Game starts nothing, so everything that runs at load is here.
// Fonts are bundled so the game makes no requests to other sites and works offline.
import '@fontsource/barlow-condensed/500.css';
import '@fontsource/barlow-condensed/600.css';
import '@fontsource/overpass/400.css';
import '@fontsource/overpass/600.css';
import '@fontsource/overpass/700.css';
import './ui/style.css';
import { Game } from './game';
import { describeStartupError, NoWebGLError } from './startupError';
import { showFatal } from './ui/fatal';

function webglAvailable(): boolean {
  try {
    return !!document.createElement('canvas').getContext('webgl2');
  } catch {
    return false;
  }
}

async function boot() {
  if (!webglAvailable()) throw new NoWebGLError();
  // Station signs are drawn to canvases once, so their font must be ready first. A slow load falls back after a moment.
  await Promise.race([document.fonts.load('600 56px Overpass'), new Promise((r) => setTimeout(r, 2000))]);
  const game = new Game();
  (window as unknown as { __game: Game }).__game = game;
  await game.start();
}

boot().catch((err) => {
  console.error(err);
  const { failure, text } = describeStartupError(err, import.meta.env.DEV);
  showFatal(text, failure !== 'no-webgl');
});
