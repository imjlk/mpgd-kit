// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  bindTutorialReplayTrigger,
  createDriverTutorialPresenter,
  resolveVisibleTutorialTarget,
} from '../src/driver.js';
import { defineTutorial } from '../src/index.js';

const tutorial = defineTutorial({
  id: 'driver.tutorial',
  initialScene: 'lobby',
  revision: 1,
  steps: [
    {
      advance: { kind: 'acknowledge' },
      id: 'blocked',
      interaction: 'blocked',
      scene: 'lobby',
      target: 'duplicate',
    },
    {
      advance: { action: 'choose', kind: 'action' },
      id: 'interactive',
      interaction: 'target',
      scene: 'lobby',
      target: 'choice',
    },
    {
      advance: { kind: 'acknowledge' },
      id: 'unanchored-blocked',
      interaction: 'blocked',
      scene: 'lobby',
      target: null,
    },
  ],
} as const);

const copy = {
  description: 'Description',
  done: 'Done',
  next: 'Next',
  skip: 'Skip',
  title: 'Title',
};

beforeEach(() => {
  document.body.innerHTML = '';
  vi.stubGlobal('ResizeObserver', class {
    disconnect() {}
    observe() {}
    unobserve() {}
  });
});

afterEach(() => {
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
});

describe('Driver tutorial presenter', () => {
  it('prefers the visible duplicate target and exposes stable gated controls', async () => {
    const hidden = document.createElement('button');
    hidden.dataset.mpgdTutorialTarget = 'duplicate';
    hidden.style.display = 'none';
    setRect(hidden, { height: 40, left: 10, top: 10, width: 100 });
    const visible = document.createElement('button');
    visible.dataset.mpgdTutorialTarget = 'duplicate';
    visible.setAttribute('aria-controls', 'original-panel');
    visible.setAttribute('aria-expanded', 'false');
    visible.setAttribute('aria-haspopup', 'menu');
    setRect(visible, { height: 40, left: 20, top: 20, width: 100 });
    document.body.append(hidden, visible);

    expect(resolveVisibleTutorialTarget({ target: 'duplicate' })).toBe(visible);
    const presenter = createDriverTutorialPresenter({
      onAcknowledge: vi.fn(),
      onSkip: vi.fn(),
    });
    presenter.present({ copy, step: tutorial.steps[0] });
    await nextFrame();

    expect(document.body.dataset.mpgdTutorialActive).toBe('true');
    expect(document.body.dataset.mpgdTutorialStep).toBe('blocked');
    expect(document.querySelector('[data-mpgd-tutorial-popover]')).not.toBeNull();
    expect(document.querySelector('[data-mpgd-tutorial-skip]')?.textContent).toBe('Skip');
    expect(document.activeElement).toBe(document.querySelector('[data-mpgd-tutorial-next]'));
    presenter.destroy();
    expect(document.body.dataset.mpgdTutorialActive).toBeUndefined();
    expect(visible.getAttribute('aria-controls')).toBe('original-panel');
    expect(visible.getAttribute('aria-expanded')).toBe('false');
    expect(visible.getAttribute('aria-haspopup')).toBe('menu');
  });

  it('rejects ancestor-hidden targets while retaining an off-viewport fallback', () => {
    const hiddenStyles = [
      ['display', 'none'],
      ['visibility', 'hidden'],
      ['opacity', '0'],
    ] as const;

    for (const [property, value] of hiddenStyles) {
      const ancestor = document.createElement('div');
      ancestor.style[property] = value;
      const target = document.createElement('button');
      target.dataset.mpgdTutorialTarget = 'duplicate';
      setRect(target, { height: 40, left: 20, top: 20, width: 100 });
      ancestor.appendChild(target);
      document.body.appendChild(ancestor);
    }

    const offViewport = document.createElement('button');
    offViewport.dataset.mpgdTutorialTarget = 'duplicate';
    setRect(offViewport, {
      height: 40,
      left: window.innerWidth + 20,
      top: 20,
      width: 100,
    });
    document.body.appendChild(offViewport);

    expect(resolveVisibleTutorialTarget({ target: 'duplicate' })).toBe(offViewport);
  });

  it('keeps interactive modal semantics and restores blocked modal semantics', async () => {
    const modal = document.createElement('section');
    modal.setAttribute('aria-modal', 'true');
    modal.setAttribute('role', 'dialog');
    setRect(modal, { height: 300, left: 20, top: 20, width: 300 });
    const choice = document.createElement('button');
    choice.dataset.mpgdTutorialTarget = 'choice';
    setRect(choice, { height: 40, left: 40, top: 40, width: 100 });
    modal.appendChild(choice);
    document.body.appendChild(modal);
    const presenter = createDriverTutorialPresenter({
      onAcknowledge: vi.fn(),
      onSkip: vi.fn(),
    });
    presenter.present({ copy, step: tutorial.steps[1] });
    await nextFrame();

    const interactivePopover = document.querySelector<HTMLElement>('[data-mpgd-tutorial-popover]');
    expect(interactivePopover?.getAttribute('role')).toBe('region');
    expect(interactivePopover?.hasAttribute('aria-modal')).toBe(false);
    expect(modal.getAttribute('aria-modal')).toBe('true');
    expect(modal.getAttribute('aria-owns')).toContain('driver-popover-content');

    const blocked = document.createElement('button');
    blocked.dataset.mpgdTutorialTarget = 'duplicate';
    setRect(blocked, { height: 40, left: 60, top: 60, width: 100 });
    modal.appendChild(blocked);
    presenter.present({ copy, step: tutorial.steps[0] });
    await nextFrame();
    const blockedPopover = document.querySelector<HTMLElement>('[data-mpgd-tutorial-popover]');
    expect(blockedPopover?.getAttribute('role')).toBe('dialog');
    expect(blockedPopover?.getAttribute('aria-modal')).toBe('true');
    expect(modal.getAttribute('aria-modal')).toBe('false');

    presenter.present({ copy, step: tutorial.steps[2] });
    await nextFrame();
    const unanchoredPopover = document.querySelector<HTMLElement>(
      '[data-mpgd-tutorial-popover]',
    );
    expect(unanchoredPopover?.getAttribute('role')).toBe('dialog');
    expect(unanchoredPopover?.getAttribute('aria-modal')).toBe('true');
    expect(modal.getAttribute('aria-modal')).toBe('false');

    presenter.destroy();
    expect(modal.getAttribute('aria-modal')).toBe('true');
    expect(modal.hasAttribute('aria-owns')).toBe(false);
  });

  it('does not associate an outside interactive target with an unrelated modal', async () => {
    const modal = document.createElement('section');
    modal.setAttribute('aria-modal', 'true');
    modal.setAttribute('role', 'dialog');
    setRect(modal, { height: 300, left: 20, top: 20, width: 300 });
    const choice = document.createElement('button');
    choice.dataset.mpgdTutorialTarget = 'choice';
    setRect(choice, { height: 40, left: 360, top: 40, width: 100 });
    document.body.append(modal, choice);
    const presenter = createDriverTutorialPresenter({
      onAcknowledge: vi.fn(),
      onSkip: vi.fn(),
    });

    presenter.present({ copy, step: tutorial.steps[1] });
    await nextFrame();

    expect(modal.hasAttribute('aria-owns')).toBe(false);
    expect(document.querySelector('[data-mpgd-tutorial-popover]')?.getAttribute('role'))
      .toBe('region');
    presenter.destroy();
  });

  it('does not overwrite host ARIA updates made during a guided step', async () => {
    const modal = document.createElement('section');
    modal.setAttribute('aria-modal', 'true');
    modal.setAttribute('role', 'dialog');
    setRect(modal, { height: 300, left: 20, top: 20, width: 300 });
    const choice = document.createElement('button');
    choice.dataset.mpgdTutorialTarget = 'choice';
    choice.setAttribute('aria-controls', 'original-panel');
    choice.setAttribute('aria-expanded', 'false');
    choice.setAttribute('aria-haspopup', 'menu');
    setRect(choice, { height: 40, left: 40, top: 40, width: 100 });
    modal.appendChild(choice);
    document.body.appendChild(modal);
    const presenter = createDriverTutorialPresenter({
      onAcknowledge: vi.fn(),
      onSkip: vi.fn(),
    });
    presenter.present({ copy, step: tutorial.steps[1] });
    await nextFrame();

    modal.setAttribute('aria-modal', 'host-closed');
    modal.setAttribute('aria-owns', 'host-owned');
    choice.setAttribute('aria-expanded', 'true');
    choice.removeAttribute('aria-controls');
    choice.setAttribute('aria-haspopup', 'dialog');
    presenter.destroy();

    expect(modal.getAttribute('aria-modal')).toBe('host-closed');
    expect(modal.getAttribute('aria-owns')).toBe('host-owned');
    expect(choice.getAttribute('aria-expanded')).toBe('true');
    expect(choice.getAttribute('aria-controls')).toBeNull();
    expect(choice.getAttribute('aria-haspopup')).toBe('dialog');
  });

  it('tracks exact-value host writes and removals on an underlying modal', async () => {
    const modal = document.createElement('section');
    modal.setAttribute('aria-modal', 'true');
    modal.setAttribute('role', 'dialog');
    setRect(modal, { height: 300, left: 20, top: 20, width: 300 });
    const choice = document.createElement('button');
    choice.dataset.mpgdTutorialTarget = 'choice';
    setRect(choice, { height: 40, left: 40, top: 40, width: 100 });
    const blocked = document.createElement('button');
    blocked.dataset.mpgdTutorialTarget = 'duplicate';
    setRect(blocked, { height: 40, left: 60, top: 60, width: 100 });
    modal.append(choice, blocked);
    document.body.appendChild(modal);
    const presenter = createDriverTutorialPresenter({
      onAcknowledge: vi.fn(),
      onSkip: vi.fn(),
    });
    presenter.present({ copy, step: tutorial.steps[1] });
    await nextFrame();

    expect(modal.getAttribute('aria-owns')).toBe('driver-popover-content');
    modal.removeAttribute('aria-owns');
    presenter.present({ copy, step: tutorial.steps[0] });
    await nextFrame();
    expect(modal.hasAttribute('aria-owns')).toBe(false);

    expect(modal.getAttribute('aria-modal')).toBe('false');
    modal.setAttribute('aria-modal', 'false');
    presenter.destroy();

    expect(modal.getAttribute('aria-modal')).toBe('false');
    expect(modal.hasAttribute('aria-owns')).toBe(false);
  });

  it('moves blocked modal ownership when the host replaces its modal', async () => {
    const firstModal = document.createElement('section');
    firstModal.setAttribute('aria-modal', 'true');
    firstModal.setAttribute('role', 'dialog');
    setRect(firstModal, { height: 300, left: 20, top: 20, width: 300 });
    document.body.appendChild(firstModal);
    const presenter = createDriverTutorialPresenter({
      onAcknowledge: vi.fn(),
      onSkip: vi.fn(),
    });
    presenter.present({ copy, step: tutorial.steps[2] });
    await nextFrame();
    expect(firstModal.getAttribute('aria-modal')).toBe('false');

    firstModal.remove();
    const secondModal = document.createElement('section');
    secondModal.setAttribute('aria-modal', 'true');
    secondModal.setAttribute('role', 'dialog');
    setRect(secondModal, { height: 300, left: 20, top: 20, width: 300 });
    document.body.appendChild(secondModal);
    await nextFrame();

    expect(firstModal.getAttribute('aria-modal')).toBe('true');
    expect(secondModal.getAttribute('aria-modal')).toBe('false');
    expect(document.querySelector('[data-mpgd-tutorial-popover]')?.getAttribute('aria-modal'))
      .toBe('true');

    const modalMutations: MutationRecord[] = [];
    const modalObserver = new MutationObserver((records) => modalMutations.push(...records));
    modalObserver.observe(secondModal, { attributeFilter: ['aria-modal'], attributes: true });
    presenter.refresh();
    await nextFrame();
    expect(modalMutations).toEqual([]);
    modalObserver.disconnect();

    presenter.destroy();
    expect(secondModal.getAttribute('aria-modal')).toBe('true');
  });

  it('cleans a detached guided target and its still-connected parent before reuse', async () => {
    const host = document.createElement('div');
    const modal = document.createElement('section');
    modal.setAttribute('aria-modal', 'true');
    modal.setAttribute('role', 'dialog');
    setRect(modal, { height: 300, left: 20, top: 20, width: 300 });
    const choice = document.createElement('button');
    choice.dataset.mpgdTutorialTarget = 'choice';
    choice.setAttribute('aria-controls', 'original-panel');
    choice.setAttribute('aria-expanded', 'false');
    choice.setAttribute('aria-haspopup', 'menu');
    setRect(choice, { height: 40, left: 40, top: 40, width: 100 });
    modal.appendChild(choice);
    host.appendChild(modal);
    document.body.appendChild(host);
    const presenter = createDriverTutorialPresenter({
      onAcknowledge: vi.fn(),
      onSkip: vi.fn(),
    });
    presenter.present({ copy, step: tutorial.steps[1] });
    await nextFrame();

    choice.remove();
    presenter.destroy();

    expect(choice.getAttribute('aria-controls')).toBe('original-panel');
    expect(choice.getAttribute('aria-expanded')).toBe('false');
    expect(choice.getAttribute('aria-haspopup')).toBe('menu');
    expect(choice.classList.contains('driver-active-element')).toBe(false);
    expect(modal.classList.contains('driver-active-element-parent')).toBe(false);
    expect(modal.getAttribute('aria-modal')).toBe('true');
    expect(modal.hasAttribute('aria-owns')).toBe(false);
  });

  it('restores tutorial-owned semantics on a detached game modal', async () => {
    const modal = document.createElement('section');
    modal.setAttribute('aria-modal', 'true');
    modal.setAttribute('role', 'dialog');
    setRect(modal, { height: 300, left: 20, top: 20, width: 300 });
    const choice = document.createElement('button');
    choice.dataset.mpgdTutorialTarget = 'choice';
    setRect(choice, { height: 40, left: 40, top: 40, width: 100 });
    modal.appendChild(choice);
    document.body.appendChild(modal);
    const presenter = createDriverTutorialPresenter({
      onAcknowledge: vi.fn(),
      onSkip: vi.fn(),
    });
    presenter.present({ copy, step: tutorial.steps[1] });
    await nextFrame();

    modal.remove();
    presenter.destroy();

    expect(modal.getAttribute('aria-modal')).toBe('true');
    expect(modal.hasAttribute('aria-owns')).toBe(false);
  });

  it('reapplies wait, error, and unanchored policies when an active target disappears', async () => {
    const createTarget = (): HTMLButtonElement => {
      const target = document.createElement('button');
      target.dataset.mpgdTutorialTarget = 'duplicate';
      setRect(target, { height: 40, left: 20, top: 20, width: 100 });
      document.body.appendChild(target);
      return target;
    };

    let target = createTarget();
    const waiting = createDriverTutorialPresenter({
      missingTarget: 'wait',
      onAcknowledge: vi.fn(),
      onSkip: vi.fn(),
    });
    waiting.present({ copy, step: tutorial.steps[0] });
    await nextFrame();
    target.remove();
    await nextFrame();
    expect(document.querySelector('[data-mpgd-tutorial-popover]')).toBeNull();
    expect(document.body.dataset.mpgdTutorialActive).toBeUndefined();
    target = createTarget();
    await nextFrame();
    expect(target.classList.contains('driver-active-element')).toBe(true);
    waiting.destroy();
    target.remove();

    target = createTarget();
    const onError = vi.fn();
    const failing = createDriverTutorialPresenter({
      missingTarget: 'error',
      onAcknowledge: vi.fn(),
      onError,
      onSkip: vi.fn(),
    });
    failing.present({ copy, step: tutorial.steps[0] });
    await nextFrame();
    target.remove();
    await nextFrame();
    expect(onError).toHaveBeenCalledOnce();
    expect(document.querySelector('[data-mpgd-tutorial-popover]')).toBeNull();
    failing.destroy();

    target = createTarget();
    const unanchored = createDriverTutorialPresenter({
      missingTarget: 'unanchored',
      onAcknowledge: vi.fn(),
      onSkip: vi.fn(),
    });
    unanchored.present({
      acknowledgeOnTargetClick: true,
      copy,
      step: tutorial.steps[0],
    });
    await nextFrame();
    target.remove();
    await nextFrame();
    expect(document.querySelector('[data-mpgd-tutorial-popover]')).not.toBeNull();
    expect(document.getElementById('driver-dummy-element')).not.toBeNull();
    expect(document.activeElement).toBe(
      document.querySelector('[data-mpgd-tutorial-next]'),
    );
    target = createTarget();
    await nextFrame();
    expect(target.classList.contains('driver-active-element')).toBe(true);
    const dummy = document.getElementById('driver-dummy-element');
    expect(dummy?.hasAttribute('aria-controls')).toBe(false);
    expect(dummy?.hasAttribute('aria-expanded')).toBe(false);
    expect(dummy?.hasAttribute('aria-haspopup')).toBe(false);
    expect(dummy?.classList.contains('driver-active-element')).toBe(false);
    unanchored.destroy();
  });

  it('rebinds visible duplicate targets after captured nested scrolling', async () => {
    const scroller = document.createElement('div');
    scroller.style.overflow = 'auto';
    setRect(scroller, { height: 100, left: 0, top: 0, width: 200 });
    const first = document.createElement('button');
    const second = document.createElement('button');
    first.dataset.mpgdTutorialTarget = 'duplicate';
    second.dataset.mpgdTutorialTarget = 'duplicate';
    let scrolled = false;
    setDynamicRect(first, () => ({ height: 40, left: 20, top: scrolled ? -100 : 20, width: 100 }));
    setDynamicRect(second, () => ({ height: 40, left: 20, top: scrolled ? 20 : 140, width: 100 }));
    scroller.append(first, second);
    document.body.appendChild(scroller);
    const presenter = createDriverTutorialPresenter({
      onAcknowledge: vi.fn(),
      onSkip: vi.fn(),
    });
    presenter.present({ copy, step: tutorial.steps[0] });
    await nextFrame();
    expect(first.classList.contains('driver-active-element')).toBe(true);

    scrolled = true;
    scroller.dispatchEvent(new Event('scroll'));
    await nextFrame();

    expect(first.classList.contains('driver-active-element')).toBe(false);
    expect(second.classList.contains('driver-active-element')).toBe(true);
    expect(scroller.classList.contains('driver-active-element-parent')).toBe(true);
    presenter.destroy();
    expect(scroller.classList.contains('driver-active-element-parent')).toBe(false);
  });

  it('reports a custom target resolver failure without escaping the frame', async () => {
    const error = new Error('resolver failed');
    const onError = vi.fn();
    const presenter = createDriverTutorialPresenter({
      onAcknowledge: vi.fn(),
      onError,
      onSkip: vi.fn(),
      resolveTarget: () => {
        throw error;
      },
    });

    presenter.present({ copy, step: tutorial.steps[0] });
    await nextFrame();

    expect(onError).toHaveBeenCalledExactlyOnceWith(error);
    expect(document.querySelector('[data-mpgd-tutorial-popover]')).toBeNull();
    presenter.destroy();
  });

  it('honors a custom resolver null result with the unanchored policy', async () => {
    const defaultTarget = document.createElement('button');
    defaultTarget.dataset.mpgdTutorialTarget = 'duplicate';
    setRect(defaultTarget, { height: 40, left: 20, top: 20, width: 100 });
    document.body.appendChild(defaultTarget);
    const resolveTarget = vi.fn(() => null);
    const presenter = createDriverTutorialPresenter({
      missingTarget: 'unanchored',
      onAcknowledge: vi.fn(),
      onSkip: vi.fn(),
      resolveTarget,
    });

    presenter.present({ copy, step: tutorial.steps[0] });
    await nextFrame();

    expect(resolveTarget).toHaveBeenCalledWith('duplicate', document);
    expect(defaultTarget.classList.contains('driver-active-element')).toBe(false);
    expect(document.querySelector('[data-mpgd-tutorial-popover]')).not.toBeNull();
    expect(document.getElementById('driver-dummy-element')).not.toBeNull();
    presenter.destroy();
  });

  it('reapplies the missing-target error policy when replaying the same step', async () => {
    const replayButton = document.createElement('button');
    const onError = vi.fn();
    const presenter = createDriverTutorialPresenter({
      missingTarget: 'error',
      onAcknowledge: vi.fn(),
      onError,
      onSkip: vi.fn(),
    });
    const presentation = { copy, step: tutorial.steps[0] };
    presenter.present(presentation);
    await nextFrame();
    expect(onError).toHaveBeenCalledOnce();

    const replay = vi.fn(async () => presenter.present(presentation));
    const unbindReplay = bindTutorialReplayTrigger({
      director: { replay } as never,
      element: replayButton,
      presenter,
    });
    replayButton.click();

    await vi.waitFor(() => expect(onError).toHaveBeenCalledTimes(2));
    expect(replay).toHaveBeenCalledOnce();
    unbindReplay();
    presenter.destroy();
  });

  it('abandons a stale resolver failure when the error handler replaces the step', async () => {
    const replacement = document.createElement('button');
    replacement.dataset.mpgdTutorialTarget = 'choice';
    setRect(replacement, { height: 40, left: 20, top: 80, width: 100 });
    document.body.appendChild(replacement);
    const onError = vi.fn();
    let presenter!: ReturnType<typeof createDriverTutorialPresenter<typeof tutorial.steps[number]>>;
    presenter = createDriverTutorialPresenter({
      missingTarget: 'error',
      onAcknowledge: vi.fn(),
      onError: (error) => {
        onError(error);
        presenter.present({ copy, step: tutorial.steps[1] });
      },
      onSkip: vi.fn(),
      resolveTarget: (target) => {
        if (target === 'duplicate') {
          throw new Error('resolver failed');
        }

        return replacement;
      },
    });

    presenter.present({ copy, step: tutorial.steps[0] });
    await nextFrame();

    expect(onError).toHaveBeenCalledOnce();
    expect(document.body.dataset.mpgdTutorialStep).toBe('interactive');
    expect(replacement.classList.contains('driver-active-element')).toBe(true);
    presenter.destroy();
  });

  it('replaces a fully active Driver instance during an active-state callback', async () => {
    const first = document.createElement('button');
    first.dataset.mpgdTutorialTarget = 'duplicate';
    setRect(first, { height: 40, left: 20, top: 20, width: 100 });
    const replacement = document.createElement('button');
    replacement.dataset.mpgdTutorialTarget = 'choice';
    setRect(replacement, { height: 40, left: 20, top: 80, width: 100 });
    document.body.append(first, replacement);
    let replaced = false;
    let presenter!: ReturnType<typeof createDriverTutorialPresenter<typeof tutorial.steps[number]>>;
    presenter = createDriverTutorialPresenter({
      onAcknowledge: vi.fn(),
      onActiveChange: (active) => {
        if (active && !replaced) {
          replaced = true;
          presenter.present({ copy, step: tutorial.steps[1] });
        }
      },
      onSkip: vi.fn(),
    });

    presenter.present({ copy, step: tutorial.steps[0] });
    await nextFrame();

    expect(document.body.dataset.mpgdTutorialStep).toBe('interactive');
    expect(document.querySelectorAll('[data-mpgd-tutorial-popover]')).toHaveLength(1);
    expect(document.body.classList.contains('driver-active')).toBe(true);
    expect(first.classList.contains('driver-active-element')).toBe(false);
    expect(replacement.classList.contains('driver-active-element')).toBe(true);
    presenter.destroy();
  });

  it('does not report a removed presentation under a reentrant replacement', async () => {
    const first = document.createElement('button');
    first.dataset.mpgdTutorialTarget = 'duplicate';
    setRect(first, { height: 40, left: 20, top: 20, width: 100 });
    const replacement = document.createElement('button');
    replacement.dataset.mpgdTutorialTarget = 'choice';
    setRect(replacement, { height: 40, left: 20, top: 80, width: 100 });
    document.body.append(first, replacement);
    const onError = vi.fn();
    let replaceWhenDismissed = false;
    let presenter!: ReturnType<typeof createDriverTutorialPresenter<typeof tutorial.steps[number]>>;
    presenter = createDriverTutorialPresenter({
      missingTarget: 'error',
      onAcknowledge: vi.fn(),
      onActiveChange: (active) => {
        if (!active && replaceWhenDismissed) {
          replaceWhenDismissed = false;
          presenter.present({ copy, step: tutorial.steps[1] });
        }
      },
      onError,
      onSkip: vi.fn(),
    });
    presenter.present({ copy, step: tutorial.steps[0] });
    await nextFrame();

    replaceWhenDismissed = true;
    first.remove();
    await nextFrame();

    expect(onError).not.toHaveBeenCalled();
    expect(document.body.dataset.mpgdTutorialStep).toBe('interactive');
    expect(replacement.classList.contains('driver-active-element')).toBe(true);
    presenter.destroy();
  });

  it('acknowledges an acknowledge-on-target-click step through Driver', async () => {
    const target = document.createElement('button');
    target.dataset.mpgdTutorialTarget = 'duplicate';
    setRect(target, { height: 40, left: 20, top: 20, width: 100 });
    document.body.appendChild(target);
    const onAcknowledge = vi.fn();
    const presenter = createDriverTutorialPresenter({
      onAcknowledge,
      onSkip: vi.fn(),
    });
    presenter.present({
      acknowledgeOnTargetClick: true,
      copy,
      step: tutorial.steps[0],
    });
    await nextFrame();

    expect(document.activeElement).toBe(
      document.querySelector('[data-mpgd-tutorial-skip]'),
    );
    target.click();

    expect(onAcknowledge).toHaveBeenCalledExactlyOnceWith('blocked');
    presenter.destroy();
  });

  it('keeps a skipped presentation dismissed when skipping fails', async () => {
    const target = document.createElement('button');
    target.dataset.mpgdTutorialTarget = 'duplicate';
    setRect(target, { height: 40, left: 20, top: 20, width: 100 });
    document.body.appendChild(target);
    const error = new Error('skip failed');
    const onError = vi.fn();
    let rejectSkip!: (error: Error) => void;
    const presenter = createDriverTutorialPresenter({
      onAcknowledge: vi.fn(),
      onError,
      onSkip: vi.fn(() => new Promise<void>((_resolve, reject) => {
        rejectSkip = reject;
      })),
    });
    const presentation = { copy, step: tutorial.steps[0] };
    presenter.present(presentation);
    await nextFrame();

    document.querySelector<HTMLButtonElement>('[data-mpgd-tutorial-skip]')?.click();
    presenter.present(null);
    presenter.present(presentation);
    await nextFrame();
    expect(document.querySelector('[data-mpgd-tutorial-popover]')).toBeNull();

    rejectSkip(error);
    await vi.waitFor(() => expect(onError).toHaveBeenCalledExactlyOnceWith(error));
    await nextFrame();
    presenter.refresh();
    await nextFrame();
    expect(document.querySelector('[data-mpgd-tutorial-popover]')).toBeNull();

    presenter.present(null);
    presenter.present(presentation);
    await nextFrame();
    expect(document.querySelector('[data-mpgd-tutorial-popover]')).not.toBeNull();
    presenter.destroy();
  });

  it('keeps a successfully skipped presentation dismissed across same-key renders', async () => {
    const target = document.createElement('button');
    target.dataset.mpgdTutorialTarget = 'duplicate';
    setRect(target, { height: 40, left: 20, top: 20, width: 100 });
    document.body.appendChild(target);
    const presenter = createDriverTutorialPresenter({
      onAcknowledge: vi.fn(),
      onSkip: vi.fn(async () => undefined),
    });
    const presentation = { copy, step: tutorial.steps[0] };
    presenter.present(presentation);
    await nextFrame();

    document.querySelector<HTMLButtonElement>('[data-mpgd-tutorial-skip]')?.click();
    await vi.waitFor(() => {
      expect(document.querySelector('[data-mpgd-tutorial-popover]')).toBeNull();
    });
    presenter.present(null);
    presenter.present(presentation);
    await nextFrame();

    expect(document.querySelector('[data-mpgd-tutorial-popover]')).toBeNull();

    const replayButton = document.createElement('button');
    const onError = vi.fn();
    let replayShouldFail = true;
    const replay = vi.fn(async () => {
      presenter.present(null);
      presenter.present(presentation);

      if (replayShouldFail) {
        throw new Error('replay failed');
      }
    });
    const unbindReplay = bindTutorialReplayTrigger({
      director: { replay } as never,
      element: replayButton,
      onError,
      presenter,
    });
    replayButton.click();
    await vi.waitFor(() => expect(onError).toHaveBeenCalledOnce());
    await nextFrame();
    expect(document.querySelector('[data-mpgd-tutorial-popover]')).toBeNull();

    replayShouldFail = false;
    replayButton.click();
    await vi.waitFor(() => expect(replay).toHaveBeenCalledTimes(2));
    await nextFrame();

    expect(document.querySelector('[data-mpgd-tutorial-popover]')).not.toBeNull();
    unbindReplay();
    presenter.destroy();
  });

  it('waits for a pending asynchronous skip before starting replay', async () => {
    const target = document.createElement('button');
    target.dataset.mpgdTutorialTarget = 'duplicate';
    setRect(target, { height: 40, left: 20, top: 20, width: 100 });
    document.body.appendChild(target);
    const events: string[] = [];
    let resolveSkip!: () => void;
    const presenter = createDriverTutorialPresenter({
      onAcknowledge: vi.fn(),
      onSkip: vi.fn(() => new Promise<void>((resolve) => {
        events.push('skip:start');
        resolveSkip = () => {
          events.push('skip:end');
          resolve();
        };
      })),
    });
    presenter.present({ copy, step: tutorial.steps[0] });
    await nextFrame();
    document.querySelector<HTMLButtonElement>('[data-mpgd-tutorial-skip]')?.click();
    await vi.waitFor(() => expect(events).toEqual(['skip:start']));

    const replayButton = document.createElement('button');
    const beforeReplay = vi.fn(() => {
      events.push('replay:prepare');
    });
    const replay = vi.fn(async () => {
      events.push('replay:start');
    });
    const unbindReplay = bindTutorialReplayTrigger({
      beforeReplay,
      director: { replay } as never,
      element: replayButton,
      presenter,
    });
    replayButton.click();
    await Promise.resolve();
    await Promise.resolve();

    expect(beforeReplay).not.toHaveBeenCalled();
    expect(replay).not.toHaveBeenCalled();

    resolveSkip();
    await vi.waitFor(() => expect(replay).toHaveBeenCalledOnce());

    expect(events).toEqual([
      'skip:start',
      'skip:end',
      'replay:prepare',
      'replay:start',
    ]);
    unbindReplay();
    presenter.destroy();
  });

  it('does not add an empty popover id to modal ownership', async () => {
    const idDescriptor = Object.getOwnPropertyDescriptor(Element.prototype, 'id');

    if (idDescriptor?.set === undefined) {
      throw new Error('Expected Element.id to expose a setter.');
    }

    Object.defineProperty(Element.prototype, 'id', {
      ...idDescriptor,
      set(value: string) {
        if (this instanceof HTMLElement && this.classList.contains('driver-popover')) {
          return;
        }

        idDescriptor.set?.call(this, value);
      },
    });

    try {
      const modal = document.createElement('section');
      modal.setAttribute('aria-modal', 'true');
      modal.setAttribute('role', 'dialog');
      const choice = document.createElement('button');
      choice.dataset.mpgdTutorialTarget = 'choice';
      setRect(choice, { height: 40, left: 40, top: 40, width: 100 });
      modal.appendChild(choice);
      document.body.appendChild(modal);
      const presenter = createDriverTutorialPresenter({
        onAcknowledge: vi.fn(),
        onSkip: vi.fn(),
      });
      presenter.present({ copy, step: tutorial.steps[1] });
      await nextFrame();

      expect(document.querySelector('.driver-popover')?.id).toBe('');
      expect(modal.hasAttribute('aria-owns')).toBe(false);
      presenter.destroy();
    } finally {
      Object.defineProperty(Element.prototype, 'id', idDescriptor);
    }
  });

  it('binds replay only when a host provides a trigger', async () => {
    const button = document.createElement('button');
    const replay = vi.fn(async () => undefined);
    const resetForReplay = vi.fn();
    const waitForPendingSkip = vi.fn(async () => undefined);
    const unbind = bindTutorialReplayTrigger({
      director: { replay } as never,
      element: button,
      presenter: { resetForReplay, waitForPendingSkip },
    });
    button.click();
    await vi.waitFor(() => expect(replay).toHaveBeenCalledOnce());
    expect(waitForPendingSkip).toHaveBeenCalledTimes(2);
    expect(resetForReplay).toHaveBeenCalledOnce();
    unbind();
    button.click();
    expect(replay).toHaveBeenCalledOnce();
    expect(resetForReplay).toHaveBeenCalledOnce();
  });

  it('rechecks pending skips after asynchronous replay preparation', async () => {
    const button = document.createElement('button');
    let resolvePreparation!: () => void;
    let resolveSecondWait!: () => void;
    const beforeReplay = vi.fn(() => new Promise<void>((resolve) => {
      resolvePreparation = resolve;
    }));
    const waitForPendingSkip = vi.fn()
      .mockResolvedValueOnce(undefined)
      .mockImplementationOnce(() => new Promise<void>((resolve) => {
        resolveSecondWait = resolve;
      }));
    const replay = vi.fn(async () => undefined);
    const unbind = bindTutorialReplayTrigger({
      beforeReplay,
      director: { replay } as never,
      element: button,
      presenter: { resetForReplay: vi.fn(), waitForPendingSkip },
    });

    button.click();
    await vi.waitFor(() => expect(beforeReplay).toHaveBeenCalledOnce());
    resolvePreparation();
    await vi.waitFor(() => expect(waitForPendingSkip).toHaveBeenCalledTimes(2));
    expect(replay).not.toHaveBeenCalled();

    resolveSecondWait();
    await vi.waitFor(() => expect(replay).toHaveBeenCalledOnce());
    unbind();
  });
});

function setRect(
  element: HTMLElement,
  rect: { readonly height: number; readonly left: number; readonly top: number; readonly width: number },
): void {
  element.getBoundingClientRect = () => ({
    bottom: rect.top + rect.height,
    height: rect.height,
    left: rect.left,
    right: rect.left + rect.width,
    top: rect.top,
    width: rect.width,
    x: rect.left,
    y: rect.top,
    toJSON: () => undefined,
  });
}

function setDynamicRect(
  element: HTMLElement,
  read: () => {
    readonly height: number;
    readonly left: number;
    readonly top: number;
    readonly width: number;
  },
): void {
  element.getBoundingClientRect = () => {
    const rect = read();

    return {
      bottom: rect.top + rect.height,
      height: rect.height,
      left: rect.left,
      right: rect.left + rect.width,
      top: rect.top,
      width: rect.width,
      x: rect.left,
      y: rect.top,
      toJSON: () => undefined,
    };
  };
}

async function nextFrame(): Promise<void> {
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
}
