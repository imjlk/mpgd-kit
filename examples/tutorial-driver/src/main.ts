import '@mpgd/tutorial/driver.css';
import './styles.css';

import {
  createTutorialDirector,
  defineTutorial,
  type TutorialStepOf,
} from '@mpgd/tutorial';
import {
  bindTutorialReplayTrigger,
  createDriverTutorialPresenter,
} from '@mpgd/tutorial/driver';
import {
  applyTutorialDebugLaunchPolicy,
  createMemoryTutorialProgressStore,
  installTutorialDebugBridge,
  resolveTutorialDebugLaunchPolicy,
} from '@mpgd/tutorial/testing';

const tutorial = defineTutorial({
  id: 'mpgd.tutorial-driver-demo',
  initialScene: 'lobby',
  revision: 1,
  steps: [
    tutorialStep('welcome', 'lobby', 'welcome', 'blocked', { kind: 'acknowledge' }, {
      description: 'The host owns every screen and decides whether a replay button exists.',
      title: 'Reusable tutorial presenter',
    }),
    tutorialStep('open-cards', 'lobby', 'cards-nav', 'target', {
      action: 'cards.open',
      kind: 'action',
    }, {
      description: 'Desktop and mobile render the same target twice. Only the visible target is highlighted.',
      title: 'Open Cards',
    }),
    tutorialStep('cards', 'cards', 'cards-panel', 'blocked', { kind: 'acknowledge' }, {
      description: 'Copy and theme stay game-owned while sequencing remains headless.',
      title: 'Game-owned content',
    }),
    tutorialStep('wait', 'cards', null, 'hidden', { kind: 'signal', signal: 'ready' }, {
      description: 'Hidden steps can wait for real game signals without showing an idle popover.',
      title: 'Wait for a signal',
    }),
    tutorialStep('open-modal', 'cards', 'open-modal', 'target', {
      action: 'modal.open',
      kind: 'action',
    }, {
      description: 'Open the modal to reproduce focus and aria-modal behavior.',
      title: 'Open a game modal',
    }),
    tutorialStep('modal-choice', 'cards', 'modal-choice', 'target', {
      action: 'modal.choose',
      kind: 'action',
    }, {
      description: 'Interactive guidance becomes a region owned by the existing game modal.',
      title: 'Choose the highlighted action',
    }),
    tutorialStep('result', 'cards', 'modal-result', 'blocked', { kind: 'acknowledge' }, {
      description: 'Blocked guidance becomes the only active modal, then restores the game modal.',
      title: 'Result guidance',
    }),
    tutorialStep('complete', 'cards', 'modal-result', 'blocked', { kind: 'acknowledge' }, {
      description: 'Completion, replay, skip, and individual steps are available through the debug bridge.',
      title: 'Harness complete',
    }),
  ],
} as const);

const app = requireElement('app');
const parameters = new URLSearchParams(window.location.search);
const debugLaunchPolicy = resolveTutorialDebugLaunchPolicy({
  definition: tutorial,
  enabled: import.meta.env.DEV,
  search: window.location.search,
});
app.innerHTML = `
  <header class="app-header" data-mpgd-tutorial-target="welcome">
    <div><small>@mpgd/tutorial</small><h1>Driver presenter harness</h1></div>
    <button id="host-replay" type="button" aria-label="Replay tutorial">?</button>
  </header>
  <div class="layout">
    <nav class="desktop-nav" aria-label="Desktop navigation">
      <button data-mpgd-tutorial-target="cards-nav" data-action="cards.open" type="button">Cards</button>
      <button type="button">Play</button>
      <button type="button">Shop</button>
    </nav>
    <section class="content">
      <div class="intro">
        <small>LOCAL REPRODUCTION</small>
        <h2>Headless flow, optional presentation</h2>
        <p>Add <code>?trigger=1</code> for a debug-only floating replay button, or <code>?host-trigger=0</code> to remove the host-owned help button.</p>
      </div>
      <article id="cards-panel" data-mpgd-tutorial-target="cards-panel" hidden>
        <small>CARDS</small>
        <h2>Host-owned screen</h2>
        <p>The demo emits its hidden <code>ready</code> signal after this step.</p>
        <button data-mpgd-tutorial-target="open-modal" data-action="modal.open" type="button">Open modal demo</button>
      </article>
      <section class="debug-panel" aria-label="Debug controls">
        <strong>Debug bridge</strong>
        <code>window.__MPGD_TUTORIAL__</code>
        <span id="state"></span>
      </section>
    </section>
  </div>
  <nav class="mobile-nav" aria-label="Mobile navigation">
    <button data-mpgd-tutorial-target="cards-nav" data-action="cards.open" type="button">Cards</button>
    <button type="button">Play</button>
    <button type="button">Shop</button>
  </nav>
  <section id="game-modal" class="game-modal" role="dialog" aria-modal="true" aria-labelledby="modal-title" hidden>
    <div>
      <small>GAME MODAL</small>
      <h2 id="modal-title">Choose a local action</h2>
      <button data-mpgd-tutorial-target="modal-choice" data-action="modal.choose" type="button">Confirm choice</button>
      <p data-mpgd-tutorial-target="modal-result">The host modal stays intact after Driver cleanup.</p>
    </div>
  </section>
`;

if (parameters.get('host-trigger') === '0') {
  requireElement('host-replay').remove();
}

const store = createMemoryTutorialProgressStore({ definition: tutorial, initial: null });
const director = createTutorialDirector({
  autoStart: debugLaunchPolicy.mode !== 'off',
  definition: tutorial,
  progressStore: store,
  suspended: debugLaunchPolicy.mode === 'off',
});
let hiddenSignalTimer: number | undefined;
const presenter = createDriverTutorialPresenter<TutorialStepOf<typeof tutorial>>({
  onAcknowledge: (stepId) => director.acknowledge(stepId),
  onSkip: () => director.skip(),
});
const unsubscribe = director.subscribe(render);
const hostReplay = document.getElementById('host-replay');
const unbindReplay = hostReplay === null
  ? () => undefined
  : bindTutorialReplayTrigger({
      beforeReplay: () => showLobby(),
      director,
      element: hostReplay,
    });
const debug = import.meta.env.DEV
  ? installTutorialDebugBridge({
      beforeReplay: (options) => prepareHostForStep(options.fromStepId ?? 'welcome'),
      director,
      floatingReplayTrigger: parameters.get('trigger') === '1'
        ? { ariaLabel: 'Debug replay tutorial', label: '?' }
        : false,
    })
  : { destroy: () => undefined };

for (const button of document.querySelectorAll<HTMLButtonElement>('[data-action]')) {
  button.addEventListener('click', () => {
    const action = button.dataset.action;

    if (action === 'cards.open') {
      requireElement('cards-panel').hidden = false;
      director.observeAction('cards.open');
      director.observeScene('cards');
    } else if (action === 'modal.open') {
      requireElement('game-modal').hidden = false;
      director.observeAction('modal.open');
    } else if (action === 'modal.choose') {
      director.observeAction('modal.choose');
    }
  });
}

try {
  await applyTutorialDebugLaunchPolicy(director, debugLaunchPolicy);
} catch (error) {
  console.error('Failed to apply the tutorial debug launch policy.', error);
}
syncHostForCurrentStep();
render();

window.addEventListener('pagehide', (event) => {
  if (event.persisted) {
    return;
  }

  if (hiddenSignalTimer !== undefined) {
    window.clearTimeout(hiddenSignalTimer);
  }

  debug.destroy();
  unbindReplay();
  unsubscribe();
  presenter.destroy();
  director.destroy();
});

function render(): void {
  const snapshot = director.getSnapshot();
  const step = snapshot.presentedStep;
  requireElement('state').textContent = JSON.stringify({
    active: snapshot.active,
    currentStepId: snapshot.currentStepId,
    replaying: snapshot.replaying,
    status: snapshot.status,
  });
  presenter.present(step === null ? null : {
    copy: {
      description: step.content.description,
      done: 'Done',
      next: 'Next',
      skip: 'Skip guide',
      title: step.content.title,
    },
    finalStep: step.id === tutorial.steps.at(-1)?.id,
    step,
  });

  if (snapshot.currentStepId === 'wait' && hiddenSignalTimer === undefined) {
    hiddenSignalTimer = window.setTimeout(() => {
      hiddenSignalTimer = undefined;
      director.observeSignal('ready');
    }, 250);
  } else if (snapshot.currentStepId !== 'wait' && hiddenSignalTimer !== undefined) {
    window.clearTimeout(hiddenSignalTimer);
    hiddenSignalTimer = undefined;
  }
}

function showLobby(): void {
  prepareHostForStep('welcome');
}

function syncHostForCurrentStep(): void {
  const stepId = director.getSnapshot().currentStepId;

  if (stepId === null) {
    return;
  }

  renderHostForStep(stepId);
  director.observeScene(sceneForStep(stepId));
}

function prepareHostForStep(stepId: TutorialStepOf<typeof tutorial>['id']): void {
  renderHostForStep(stepId);
  director.observeScene(sceneForStep(stepId));
}

function renderHostForStep(stepId: TutorialStepOf<typeof tutorial>['id']): void {
  const cardsVisible = stepId !== 'welcome' && stepId !== 'open-cards';
  const modalVisible = stepId === 'modal-choice' || stepId === 'result' || stepId === 'complete';
  requireElement('cards-panel').hidden = !cardsVisible;
  requireElement('game-modal').hidden = !modalVisible;
}

function sceneForStep(stepId: TutorialStepOf<typeof tutorial>['id']): 'cards' | 'lobby' {
  return stepId === 'welcome' || stepId === 'open-cards' ? 'lobby' : 'cards';
}

function tutorialStep<
  const TId extends string,
  const TScene extends string,
  const TTarget extends string | null,
  const TInteraction extends 'blocked' | 'target' | 'gameplay' | 'hidden',
  const TAdvance extends
    | { readonly kind: 'acknowledge' }
    | { readonly action: string; readonly kind: 'action' }
    | { readonly kind: 'signal'; readonly signal: string },
>(
  id: TId,
  scene: TScene,
  target: TTarget,
  interaction: TInteraction,
  advance: TAdvance,
  content: { readonly description: string; readonly title: string },
) {
  return { advance, content, id, interaction, scene, target } as const;
}

function requireElement(id: string): HTMLElement {
  const element = document.getElementById(id);

  if (element === null) {
    throw new Error(`Missing tutorial harness element: ${id}`);
  }

  return element;
}
