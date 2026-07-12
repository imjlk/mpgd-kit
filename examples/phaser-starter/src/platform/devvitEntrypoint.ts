import { requestDevvitExpandedMode, startDevvitWebSurface } from '@mpgd/adapter-devvit/web';

await startDevvitWebSurface({
  async mountInlinePreview() {
    await import('./devvitInlinePreview.css');
    renderInlinePreview();
  },
  async loadExpandedGame() {
    await import('../main');
  },
  onModeUnavailable(error) {
    if (!(error instanceof ReferenceError)) {
      console.warn('[devvit] web view mode unavailable; loading the game surface.', error);
    }
  },
});

function renderInlinePreview(): void {
  const preview = document.createElement('main');
  preview.className = 'devvit-preview';

  const eyebrow = document.createElement('p');
  eyebrow.className = 'devvit-preview__eyebrow';
  eyebrow.textContent = 'Ready to play';

  const title = document.createElement('h1');
  title.textContent = 'mpgd Phaser Starter';

  const description = document.createElement('p');
  description.className = 'devvit-preview__description';
  description.textContent = 'Open the expanded view to start the game.';

  const button = document.createElement('button');
  button.className = 'devvit-preview__button';
  button.type = 'button';
  button.textContent = 'Play';
  button.addEventListener('click', (event) => {
    try {
      requestDevvitExpandedMode(event, 'game');
    } catch (error) {
      console.error('[devvit] expanded game surface request failed.', error);
    }
  });

  preview.append(eyebrow, title, description, button);
  const body = document.body;

  if (body === null) {
    throw new Error('Devvit inline preview requires a document body.');
  }

  body.classList.add('devvit-preview-host');
  body.replaceChildren(preview);
}
