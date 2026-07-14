import {
  requestDevvitExpandedMode,
  startDevvitWebView,
  type DevvitInlineModeContext,
} from '@mpgd/adapter-devvit/web';

await startDevvitWebView({
  async mountInlineMode(context) {
    await import('./devvitInlineMode.css');
    renderInlineLaunchScreen(context);
  },
  async loadGameplay() {
    await import('../main');
  },
  onModeUnavailable(error) {
    if (!(error instanceof ReferenceError)) {
      console.warn('[devvit] web view mode unavailable; loading gameplay.', error);
    }
  },
});

function renderInlineLaunchScreen(
  context: DevvitInlineModeContext,
  errorMessage?: string,
): void {
  const launchScreen = document.createElement('main');
  launchScreen.className = 'devvit-launch-screen';

  const eyebrow = document.createElement('p');
  eyebrow.className = 'devvit-launch-screen__eyebrow';
  eyebrow.textContent = 'Inline mode';

  const title = document.createElement('h1');
  title.textContent = '__GAME_TITLE__';

  const description = document.createElement('p');
  description.className = 'devvit-launch-screen__description';
  description.textContent = 'Play directly in the post or open expanded mode.';

  const actions = document.createElement('div');
  actions.className = 'devvit-launch-screen__actions';

  const playInlineButton = document.createElement('button');
  playInlineButton.className = 'devvit-launch-screen__button';
  playInlineButton.type = 'button';
  playInlineButton.textContent = 'Play here';

  const expandButton = document.createElement('button');
  expandButton.className =
    'devvit-launch-screen__button devvit-launch-screen__button--secondary';
  expandButton.type = 'button';
  expandButton.textContent = 'Open expanded mode';

  const status = document.createElement('p');
  status.className = 'devvit-launch-screen__status';
  status.setAttribute('aria-live', 'polite');
  status.textContent = errorMessage ?? '';

  playInlineButton.addEventListener('click', () => {
    setBusy(true, 'Loading gameplay…');
    mountGameplayDocument();

    void context.startGameplay().catch((error: unknown) => {
      console.error('[devvit] inline mode gameplay failed to load.', error);
      renderInlineLaunchScreen(context, 'Gameplay could not start. Try again.');
    });
  });
  expandButton.addEventListener('click', (event) => {
    setBusy(true, 'Opening expanded mode…');

    void requestDevvitExpandedMode(event, 'game').catch((error: unknown) => {
      console.error('[devvit] expanded mode request failed.', error);
      setBusy(false, 'Expanded mode is unavailable. Try again.');
    });
  });

  actions.append(playInlineButton, expandButton);
  launchScreen.append(eyebrow, title, description, actions, status);
  const body = requireDocumentBody();

  body.classList.add('devvit-inline-mode-host');
  body.replaceChildren(launchScreen);

  function setBusy(busy: boolean, message: string): void {
    playInlineButton.disabled = busy;
    expandButton.disabled = busy;
    status.textContent = message;
  }
}

function mountGameplayDocument(): void {
  const body = requireDocumentBody();
  const app = document.createElement('main');
  const game = document.createElement('div');

  app.id = 'app';
  game.id = 'game';
  app.append(game);

  body.classList.remove('devvit-inline-mode-host');
  body.replaceChildren(app);
}

function requireDocumentBody(): HTMLElement {
  const body = document.body;

  if (body === null) {
    throw new Error('Devvit inline mode requires a document body.');
  }

  return body;
}
