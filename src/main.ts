// Entry point. Importing Game starts nothing, so everything that runs at load is here.
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
  const game = new Game();
  (window as unknown as { __game: Game }).__game = game;
  await game.start();
}

boot().catch((err) => {
  console.error(err);
  const { failure, text } = describeStartupError(err, import.meta.env.DEV);
  showFatal(text, failure !== 'no-webgl');
});
