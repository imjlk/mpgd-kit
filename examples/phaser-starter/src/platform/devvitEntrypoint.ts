import {
  requestDevvitExpandedMode,
  startDevvitPreviewWebView,
} from '@mpgd/adapter-devvit/web';

const expandedRequestRecoveryMs = 8_000;

await startDevvitPreviewWebView({
  async mountInlinePreview() {
    await import('./devvitInlineMode.css');
    renderInlineLaunchScreen();
  },
  async loadExpandedGame() {
    await import('../main');
  },
  onModeUnavailable(error) {
    if (!(error instanceof ReferenceError)) {
      console.warn('[devvit] web view mode unavailable; loading expanded gameplay.', error);
    }
  },
});

function renderInlineLaunchScreen(): void {
  const launchScreen = document.createElement('main');
  launchScreen.className = 'devvit-launch-screen';

  const eyebrow = document.createElement('p');
  eyebrow.className = 'devvit-launch-screen__eyebrow';
  eyebrow.textContent = 'Inline mode';

  const title = document.createElement('h1');
  title.textContent = 'mpgd Phaser Starter';

  const description = document.createElement('p');
  description.className = 'devvit-launch-screen__description';
  description.textContent = 'Open the full game without interrupting your Reddit feed.';

  const actions = document.createElement('div');
  actions.className = 'devvit-launch-screen__actions';

  const expandButton = document.createElement('button');
  expandButton.className = 'devvit-launch-screen__button';
  expandButton.type = 'button';
  expandButton.textContent = 'Play full screen';

  const status = document.createElement('p');
  status.className = 'devvit-launch-screen__status';
  status.setAttribute('aria-live', 'polite');
  status.setAttribute('role', 'status');

  let nextRequestId = 0;
  let activeRequestId: number | undefined;
  let recoveryTimeout: ReturnType<typeof globalThis.setTimeout> | undefined;
  const recover = (requestId: number, message: string) => {
    if (activeRequestId !== requestId) {
      return;
    }

    activeRequestId = undefined;
    if (recoveryTimeout !== undefined) {
      globalThis.clearTimeout(recoveryTimeout);
      recoveryTimeout = undefined;
    }

    expandButton.disabled = false;
    status.textContent = message;
  };
  expandButton.addEventListener('click', (event) => {
    const requestId = ++nextRequestId;

    activeRequestId = requestId;
    expandButton.disabled = true;
    status.textContent = 'Opening full screen…';
    recoveryTimeout = globalThis.setTimeout(() => {
      recover(requestId, 'Full screen did not open. Try again.');
    }, expandedRequestRecoveryMs);

    void requestDevvitExpandedMode(event, 'game')
      .catch((error: unknown) => {
        console.error('[devvit] expanded mode request failed.', error);
        recover(requestId, 'Full screen is unavailable. Try again.');
      });
  });
  const recoverAfterReturn = () => {
    if (activeRequestId !== undefined) {
      recover(activeRequestId, '');
    }
  };
  globalThis.addEventListener('focus', recoverAfterReturn);
  globalThis.addEventListener('pageshow', recoverAfterReturn);

  actions.append(expandButton);
  launchScreen.append(eyebrow, title, description, actions, status);
  const body = requireDocumentBody();

  body.classList.add('devvit-inline-mode-host');
  delete body.dataset.mpgdPreserveBrowserTouchGestures;
  body.replaceChildren(launchScreen);
}

function requireDocumentBody(): HTMLElement {
  const body = document.body;

  if (body === null) {
    throw new Error('Devvit inline mode requires a document body.');
  }

  return body;
}
