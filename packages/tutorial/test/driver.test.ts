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
  it('resolves raw target attribute values containing CSS control characters', () => {
    const target = document.createElement('button');
    const value = 'line\nreturn\rform\fnull\0end';
    target.setAttribute('data-mpgd-tutorial-target', value);
    setRect(target, { height: 40, left: 20, top: 20, width: 100 });
    document.body.appendChild(target);

    expect(resolveVisibleTutorialTarget({ target: value })).toBe(target);
  });

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

  it('recreates a same-id presentation when rendering fields change', async () => {
    const first = document.createElement('button');
    const second = document.createElement('button');
    first.dataset.mpgdTutorialTarget = 'duplicate';
    second.dataset.mpgdTutorialTarget = 'choice';
    setRect(first, { height: 40, left: 20, top: 20, width: 100 });
    setRect(second, { height: 40, left: 180, top: 20, width: 100 });
    document.body.append(first, second);
    const presenter = createDriverTutorialPresenter({
      onAcknowledge: vi.fn(),
      onSkip: vi.fn(),
    });

    try {
      presenter.present({ copy, step: tutorial.steps[0] });
      await nextFrame();
      const firstPopover = document.querySelector('[data-mpgd-tutorial-popover]');
      expect(first.classList.contains('driver-active-element')).toBe(true);

      presenter.present({
        copy,
        step: {
          ...tutorial.steps[1],
          id: tutorial.steps[0].id,
          side: 'left',
        },
      });
      await nextFrame();

      expect(document.querySelector('[data-mpgd-tutorial-popover]')).not.toBe(firstPopover);
      expect(first.classList.contains('driver-active-element')).toBe(false);
      expect(second.classList.contains('driver-active-element')).toBe(true);
    } finally {
      presenter.destroy();
    }
  });

  it('resolves a standard tutorial target through an open shadow root', async () => {
    const driverPointerRules = installDriverPointerRules();
    const host = document.createElement('div');
    const shadowRoot = host.attachShadow({ mode: 'open' });
    const target = document.createElement('button');
    target.dataset.mpgdTutorialTarget = 'duplicate';
    setRect(target, { height: 40, left: 20, top: 20, width: 100 });
    shadowRoot.appendChild(target);
    document.body.appendChild(host);

    expect(resolveVisibleTutorialTarget({ target: 'duplicate' })).toBe(target);
    expect(resolveVisibleTutorialTarget({ root: host, target: 'duplicate' })).toBe(target);
    const onAcknowledge = vi.fn();
    const onActiveChange = vi.fn();
    const presenter = createDriverTutorialPresenter({
      onAcknowledge,
      onActiveChange,
      onSkip: vi.fn(),
      root: host,
    });

    try {
      presenter.present({
        acknowledgeOnTargetClick: true,
        copy,
        step: tutorial.steps[0],
      });
      await nextFrame();

      expect(target.classList.contains('driver-active-element')).toBe(true);
      expect(target.style.getPropertyValue('pointer-events')).toBe('');
      expect([...shadowRoot.querySelectorAll('style')].some((style) => (
        style.textContent?.includes('.driver-active-element:not(.driver-no-interaction)') === true
      ))).toBe(true);
      expect(getComputedStyle(target).pointerEvents).toBe('auto');
      const initialPopover = document.querySelector('[data-mpgd-tutorial-popover]');
      await nextFrame();
      expect(document.querySelector('[data-mpgd-tutorial-popover]')).toBe(initialPopover);
      expect(shadowRoot.querySelectorAll('style')).toHaveLength(1);
      expect(onActiveChange).toHaveBeenCalledExactlyOnceWith(true);
      await clickAndFlush(target);
      expect(onAcknowledge).toHaveBeenCalledExactlyOnceWith('blocked');
    } finally {
      presenter.destroy();
      expect(target.style.getPropertyValue('pointer-events')).toBe('');
      expect(shadowRoot.querySelector('style')).toBeNull();
      driverPointerRules.remove();
    }
  });

  it('does not restart a scoped target for matching nodes outside its root', async () => {
    const driverPointerRules = installDriverPointerRules();
    const root = document.createElement('section');
    const target = document.createElement('button');
    const focusAnchor = document.createElement('button');
    target.dataset.mpgdTutorialTarget = 'duplicate';
    setRect(target, { height: 40, left: 20, top: 20, width: 100 });
    root.appendChild(target);
    document.body.append(root, focusAnchor);
    const presenter = createDriverTutorialPresenter({
      onAcknowledge: vi.fn(),
      onSkip: vi.fn(),
      root,
    });

    try {
      presenter.present({
        acknowledgeOnTargetClick: true,
        copy,
        step: tutorial.steps[0],
      });
      await nextFrame();
      const initialPopover = document.querySelector('[data-mpgd-tutorial-popover]');
      focusAnchor.focus();

      const outsideTarget = document.createElement('button');
      outsideTarget.dataset.mpgdTutorialTarget = 'duplicate';
      setRect(outsideTarget, { height: 40, left: 140, top: 20, width: 100 });
      const shadowHost = document.createElement('div');
      const shadowTarget = document.createElement('button');
      shadowTarget.dataset.mpgdTutorialTarget = 'duplicate';
      setRect(shadowTarget, { height: 40, left: 260, top: 20, width: 100 });
      shadowHost.attachShadow({ mode: 'open' }).appendChild(shadowTarget);
      document.body.append(outsideTarget, shadowHost);
      await nextFrame();

      expect(document.querySelector('[data-mpgd-tutorial-popover]')).toBe(initialPopover);
      expect(document.activeElement).toBe(focusAnchor);
      expect(target.classList.contains('driver-active-element')).toBe(true);
      expect(outsideTarget.classList.contains('driver-active-element')).toBe(false);
      expect(shadowTarget.classList.contains('driver-active-element')).toBe(false);
    } finally {
      presenter.destroy();
      driverPointerRules.remove();
    }
  });

  it('restarts for character data in a sibling stylesheet in the shadow tree scope', async () => {
    const driverPointerRules = installDriverPointerRules();
    const host = document.createElement('div');
    const shadowRoot = host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    const styleText = document.createTextNode('.stylesheet-controlled {}');
    const root = document.createElement('section');
    const target = document.createElement('button');
    style.appendChild(styleText);
    target.className = 'stylesheet-controlled';
    target.dataset.mpgdTutorialTarget = 'duplicate';
    setRect(target, { height: 40, left: 20, top: 20, width: 100 });
    root.appendChild(target);
    shadowRoot.append(style, root);
    document.body.appendChild(host);
    const onActiveChange = vi.fn();
    const presenter = createDriverTutorialPresenter({
      onAcknowledge: vi.fn(),
      onActiveChange,
      onSkip: vi.fn(),
      root,
    });

    try {
      presenter.present({
        acknowledgeOnTargetClick: true,
        copy,
        step: tutorial.steps[0],
      });
      await nextFrame();
      const interactivePopover = document.querySelector('[data-mpgd-tutorial-popover]');

      styleText.data = '.stylesheet-controlled { pointer-events: none; }';
      await nextFrame();
      const blockedPopover = document.querySelector('[data-mpgd-tutorial-popover]');
      expect(blockedPopover).not.toBe(interactivePopover);
      expect(target.classList.contains('driver-no-interaction')).toBe(true);
      expect(document.querySelector<HTMLElement>('[data-mpgd-tutorial-next]')?.style.display)
        .toBe('block');

      styleText.data = '.stylesheet-controlled { pointer-events: auto; }';
      await nextFrame();
      expect(document.querySelector('[data-mpgd-tutorial-popover]')).not.toBe(blockedPopover);
      expect(target.classList.contains('driver-no-interaction')).toBe(false);
      expect(getComputedStyle(target).pointerEvents).toBe('auto');
      expect(onActiveChange).toHaveBeenCalledExactlyOnceWith(true);
    } finally {
      presenter.destroy();
      driverPointerRules.remove();
    }
  });

  it('does not restart for stylesheet character data in a different shadow tree', async () => {
    const driverPointerRules = installDriverPointerRules();
    const host = document.createElement('div');
    const shadowRoot = host.attachShadow({ mode: 'open' });
    const root = document.createElement('section');
    const target = document.createElement('button');
    const outsideHost = document.createElement('div');
    const outsideShadowRoot = outsideHost.attachShadow({ mode: 'open' });
    const outsideStyle = document.createElement('style');
    const outsideStyleText = document.createTextNode('.unrelated {}');
    const focusAnchor = document.createElement('button');
    target.dataset.mpgdTutorialTarget = 'duplicate';
    setRect(target, { height: 40, left: 20, top: 20, width: 100 });
    root.appendChild(target);
    shadowRoot.appendChild(root);
    outsideStyle.appendChild(outsideStyleText);
    outsideShadowRoot.appendChild(outsideStyle);
    document.body.append(host, outsideHost, focusAnchor);
    const presenter = createDriverTutorialPresenter({
      onAcknowledge: vi.fn(),
      onSkip: vi.fn(),
      root,
    });

    try {
      presenter.present({
        acknowledgeOnTargetClick: true,
        copy,
        step: tutorial.steps[0],
      });
      await nextFrame();
      const initialPopover = document.querySelector('[data-mpgd-tutorial-popover]');
      focusAnchor.focus();

      outsideStyleText.data = '.unrelated { pointer-events: none; }';
      await nextFrame();

      expect(document.querySelector('[data-mpgd-tutorial-popover]')).toBe(initialPopover);
      expect(document.activeElement).toBe(focusAnchor);
      expect(target.classList.contains('driver-active-element')).toBe(true);
    } finally {
      presenter.destroy();
      driverPointerRules.remove();
    }
  });

  it('does not restart a document-scoped light target for an unrelated shadow stylesheet', async () => {
    const driverPointerRules = installDriverPointerRules();
    const target = document.createElement('button');
    const outsideHost = document.createElement('div');
    const outsideStyle = document.createElement('style');
    const outsideStyleText = document.createTextNode('.unrelated {}');
    const focusAnchor = document.createElement('button');
    target.dataset.mpgdTutorialTarget = 'duplicate';
    setRect(target, { height: 40, left: 20, top: 20, width: 100 });
    outsideStyle.appendChild(outsideStyleText);
    outsideHost.attachShadow({ mode: 'open' }).appendChild(outsideStyle);
    document.body.append(target, outsideHost, focusAnchor);
    const presenter = createDriverTutorialPresenter({
      onAcknowledge: vi.fn(),
      onSkip: vi.fn(),
    });

    try {
      presenter.present({
        acknowledgeOnTargetClick: true,
        copy,
        step: tutorial.steps[0],
      });
      await nextFrame();
      const initialPopover = document.querySelector('[data-mpgd-tutorial-popover]');
      focusAnchor.focus();

      outsideStyleText.data = '.unrelated { pointer-events: none; }';
      await nextFrame();

      expect(document.querySelector('[data-mpgd-tutorial-popover]')).toBe(initialPopover);
      expect(document.activeElement).toBe(focusAnchor);
      expect(target.classList.contains('driver-active-element')).toBe(true);
    } finally {
      presenter.destroy();
      driverPointerRules.remove();
    }
  });

  it('selects the duplicate inside a shifted narrow visual viewport', () => {
    vi.stubGlobal('visualViewport', {
      height: 240,
      offsetLeft: 400,
      offsetTop: 100,
      width: 240,
    });
    const layoutViewportTarget = document.createElement('button');
    layoutViewportTarget.dataset.mpgdTutorialTarget = 'duplicate';
    setRect(layoutViewportTarget, { height: 40, left: 20, top: 20, width: 100 });
    const visualViewportTarget = document.createElement('button');
    visualViewportTarget.dataset.mpgdTutorialTarget = 'duplicate';
    setRect(visualViewportTarget, { height: 40, left: 420, top: 120, width: 100 });
    document.body.append(layoutViewportTarget, visualViewportTarget);

    expect(resolveVisibleTutorialTarget({ target: 'duplicate' })).toBe(visualViewportTarget);
  });

  it('focuses the rendered skip control for blocked action and signal steps', async () => {
    const outside = document.createElement('button');
    document.body.appendChild(outside);
    const blockedSteps = [
      {
        advance: { action: 'continue', kind: 'action' },
        id: 'blocked-action',
        interaction: 'blocked',
        scene: 'lobby',
        target: null,
      },
      {
        advance: { kind: 'signal', signal: 'continue' },
        id: 'blocked-signal',
        interaction: 'blocked',
        scene: 'lobby',
        target: null,
      },
    ] as const;

    for (const step of blockedSteps) {
      outside.focus();
      const presenter = createDriverTutorialPresenter({
        onAcknowledge: vi.fn(),
        onSkip: vi.fn(),
      });
      presenter.present({ copy, step });
      await nextFrame();

      expect(document.activeElement).toBe(
        document.querySelector('[data-mpgd-tutorial-skip]'),
      );
      presenter.destroy();
    }
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

  it('skips semantically inactive duplicates for target-click acknowledgement', async () => {
    const inertWrapper = document.createElement('div');
    inertWrapper.setAttribute('inert', '');
    const inertTarget = document.createElement('button');
    inertTarget.dataset.mpgdTutorialTarget = 'duplicate';
    setRect(inertTarget, { height: 40, left: 20, top: 20, width: 100 });
    inertWrapper.appendChild(inertTarget);
    const shadowHost = document.createElement('div');
    const shadowRoot = shadowHost.attachShadow({ mode: 'open' });
    const ariaHiddenWrapper = document.createElement('div');
    ariaHiddenWrapper.setAttribute('aria-hidden', 'true');
    const slot = document.createElement('slot');
    slot.name = 'inactive-target';
    ariaHiddenWrapper.appendChild(slot);
    shadowRoot.appendChild(ariaHiddenWrapper);
    const slottedTarget = document.createElement('button');
    slottedTarget.dataset.mpgdTutorialTarget = 'duplicate';
    slottedTarget.slot = slot.name;
    setRect(slottedTarget, { height: 40, left: 140, top: 20, width: 100 });
    shadowHost.appendChild(slottedTarget);
    const activeTarget = document.createElement('button');
    activeTarget.dataset.mpgdTutorialTarget = 'duplicate';
    setRect(activeTarget, { height: 40, left: 260, top: 20, width: 100 });
    document.body.append(inertWrapper, shadowHost, activeTarget);
    const onAcknowledge = vi.fn();
    const presenter = createDriverTutorialPresenter({
      onAcknowledge,
      onSkip: vi.fn(),
    });

    try {
      presenter.present({
        acknowledgeOnTargetClick: true,
        copy,
        step: tutorial.steps[0],
      });
      await nextFrame();

      expect(inertTarget.classList.contains('driver-active-element')).toBe(false);
      expect(slottedTarget.assignedSlot).toBe(slot);
      expect(slottedTarget.classList.contains('driver-active-element')).toBe(false);
      expect(activeTarget.classList.contains('driver-active-element')).toBe(true);
      inertTarget.click();
      slottedTarget.click();
      expect(onAcknowledge).not.toHaveBeenCalled();
      await clickAndFlush(activeTarget);
      expect(onAcknowledge).toHaveBeenCalledExactlyOnceWith('blocked');
    } finally {
      presenter.destroy();
    }
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

  it('owns alertdialog modal semantics by default', async () => {
    const modal = document.createElement('section');
    modal.setAttribute('aria-modal', 'true');
    modal.setAttribute('role', 'alertdialog');
    setRect(modal, { height: 300, left: 20, top: 20, width: 300 });
    const target = document.createElement('button');
    target.dataset.mpgdTutorialTarget = 'duplicate';
    setRect(target, { height: 40, left: 40, top: 40, width: 100 });
    modal.appendChild(target);
    document.body.appendChild(modal);
    const presenter = createDriverTutorialPresenter({
      onAcknowledge: vi.fn(),
      onSkip: vi.fn(),
    });

    presenter.present({ copy, step: tutorial.steps[0] });
    await nextFrame();

    expect(modal.getAttribute('aria-modal')).toBe('false');
    presenter.destroy();
    expect(modal.getAttribute('aria-modal')).toBe('true');
  });

  it('associates a shadow target with its composed light-DOM modal host', async () => {
    const modal = document.createElement('section');
    modal.setAttribute('aria-modal', 'true');
    modal.setAttribute('role', 'dialog');
    setRect(modal, { height: 300, left: 20, top: 20, width: 300 });
    const shadowRoot = modal.attachShadow({ mode: 'open' });
    const choice = document.createElement('button');
    choice.dataset.mpgdTutorialTarget = 'choice';
    setRect(choice, { height: 40, left: 40, top: 40, width: 100 });
    shadowRoot.appendChild(choice);
    document.body.appendChild(modal);
    const presenter = createDriverTutorialPresenter({
      onAcknowledge: vi.fn(),
      onSkip: vi.fn(),
      resolveTarget: () => choice,
    });

    try {
      presenter.present({ copy, step: tutorial.steps[1] });
      await nextFrame();

      expect(document.querySelector('[data-mpgd-tutorial-popover]')?.getAttribute('role'))
        .toBe('region');
      expect(modal.getAttribute('aria-owns')).toContain('driver-popover-content');
    } finally {
      presenter.destroy();
    }
    expect(modal.hasAttribute('aria-owns')).toBe(false);
  });

  it('associates an unanchored blocked step with the renderable modal', async () => {
    const hiddenModal = document.createElement('section');
    hiddenModal.setAttribute('aria-modal', 'true');
    hiddenModal.setAttribute('role', 'dialog');
    hiddenModal.style.display = 'none';
    setRect(hiddenModal, { height: 300, left: 20, top: 20, width: 300 });
    const ariaHiddenModal = document.createElement('section');
    ariaHiddenModal.setAttribute('aria-hidden', 'true');
    ariaHiddenModal.setAttribute('aria-modal', 'true');
    ariaHiddenModal.setAttribute('role', 'dialog');
    setRect(ariaHiddenModal, { height: 300, left: 340, top: 20, width: 300 });
    const inertShell = document.createElement('div');
    inertShell.setAttribute('inert', '');
    const inertModal = document.createElement('section');
    inertModal.setAttribute('aria-modal', 'true');
    inertModal.setAttribute('role', 'dialog');
    setRect(inertModal, { height: 300, left: 660, top: 20, width: 300 });
    inertShell.appendChild(inertModal);
    const visibleModal = document.createElement('section');
    visibleModal.setAttribute('aria-modal', 'true');
    visibleModal.setAttribute('role', 'dialog');
    setRect(visibleModal, { height: 300, left: 20, top: 340, width: 300 });
    document.body.append(hiddenModal, ariaHiddenModal, inertShell, visibleModal);
    const presenter = createDriverTutorialPresenter({
      onAcknowledge: vi.fn(),
      onSkip: vi.fn(),
    });

    try {
      presenter.present({ copy, step: tutorial.steps[2] });
      await nextFrame();

      expect(hiddenModal.getAttribute('aria-modal')).toBe('true');
      expect(ariaHiddenModal.getAttribute('aria-modal')).toBe('true');
      expect(inertModal.getAttribute('aria-modal')).toBe('true');
      expect(visibleModal.getAttribute('aria-modal')).toBe('false');
    } finally {
      presenter.destroy();
    }
    expect(visibleModal.getAttribute('aria-modal')).toBe('true');
  });

  it('discovers an unanchored blocked modal inside an open shadow root', async () => {
    const host = document.createElement('div');
    const shadowRoot = host.attachShadow({ mode: 'open' });
    const shadowModal = document.createElement('section');
    shadowModal.setAttribute('aria-modal', 'true');
    shadowModal.setAttribute('role', 'dialog');
    setRect(shadowModal, { height: 300, left: 20, top: 20, width: 300 });
    shadowRoot.appendChild(shadowModal);
    document.body.appendChild(host);
    const presenter = createDriverTutorialPresenter({
      onAcknowledge: vi.fn(),
      onSkip: vi.fn(),
    });

    try {
      presenter.present({ copy, step: tutorial.steps[2] });
      await nextFrame();

      expect(shadowModal.getAttribute('aria-modal')).toBe('false');
      expect(document.querySelector('[data-mpgd-tutorial-popover]')?.getAttribute('aria-modal'))
        .toBe('true');
    } finally {
      presenter.destroy();
    }
    expect(shadowModal.getAttribute('aria-modal')).toBe('true');
  });

  it('observes an open shadow root added after an unanchored presentation', async () => {
    const requestFrame = vi.spyOn(window, 'requestAnimationFrame');
    const presenter = createDriverTutorialPresenter({
      onAcknowledge: vi.fn(),
      onSkip: vi.fn(),
    });

    try {
      presenter.present({ copy, step: tutorial.steps[2] });
      await nextFrame();

      const host = document.createElement('div');
      const shadowRoot = host.attachShadow({ mode: 'open' });
      const shadowModal = document.createElement('section');
      shadowModal.setAttribute('aria-modal', 'true');
      shadowModal.setAttribute('role', 'dialog');
      setRect(shadowModal, { height: 300, left: 20, top: 20, width: 300 });
      shadowRoot.appendChild(shadowModal);
      document.body.appendChild(host);
      await nextFrame();
      await nextFrame();

      expect(shadowModal.getAttribute('aria-modal')).toBe('false');
      const settledFrameCount = requestFrame.mock.calls.length;
      await nextFrame();
      expect(requestFrame.mock.calls).toHaveLength(settledFrameCount + 2);

      presenter.destroy();
      expect(shadowModal.getAttribute('aria-modal')).toBe('true');
      const destroyedFrameCount = requestFrame.mock.calls.length;
      shadowRoot.appendChild(document.createElement('div'));
      await nextFrame();
      expect(requestFrame.mock.calls).toHaveLength(destroyedFrameCount + 2);
    } finally {
      presenter.destroy();
      requestFrame.mockRestore();
    }
  });

  it('stops observing an open shadow root after its host is detached', async () => {
    const host = document.createElement('div');
    const shadowRoot = host.attachShadow({ mode: 'open' });
    const shadowModal = document.createElement('section');
    shadowModal.setAttribute('aria-modal', 'true');
    shadowModal.setAttribute('role', 'dialog');
    setRect(shadowModal, { height: 300, left: 20, top: 20, width: 300 });
    shadowRoot.appendChild(shadowModal);
    document.body.appendChild(host);
    const requestFrame = vi.spyOn(window, 'requestAnimationFrame');
    const presenter = createDriverTutorialPresenter({
      onAcknowledge: vi.fn(),
      onSkip: vi.fn(),
    });

    try {
      presenter.present({ copy, step: tutorial.steps[2] });
      await nextFrame();
      expect(shadowModal.getAttribute('aria-modal')).toBe('false');

      host.remove();
      await nextFrame();
      await nextFrame();
      const detachedFrameCount = requestFrame.mock.calls.length;

      shadowRoot.appendChild(document.createElement('div'));
      await nextFrame();

      expect(requestFrame.mock.calls).toHaveLength(detachedFrameCount + 2);
    } finally {
      presenter.destroy();
      requestFrame.mockRestore();
    }
  });

  it('does not rescan open shadow roots while inactive and rediscovers them on presentation', async () => {
    const host = document.createElement('div');
    const shadowRoot = host.attachShadow({ mode: 'open' });
    const target = document.createElement('button');
    target.dataset.mpgdTutorialTarget = 'duplicate';
    setRect(target, { height: 40, left: 20, top: 20, width: 100 });
    shadowRoot.appendChild(target);
    document.body.appendChild(host);
    const actualShadowRoot = shadowRoot;
    let shadowRootReads = 0;
    Object.defineProperty(host, 'shadowRoot', {
      configurable: true,
      get: () => {
        shadowRootReads += 1;
        return actualShadowRoot;
      },
    });
    const presenter = createDriverTutorialPresenter({
      onAcknowledge: vi.fn(),
      onSkip: vi.fn(),
    });

    try {
      expect(shadowRootReads).toBe(0);
      document.body.appendChild(document.createElement('div'));
      await nextFrame();
      expect(shadowRootReads).toBe(0);

      presenter.present({ copy, step: tutorial.steps[0] });
      await nextFrame();
      expect(shadowRootReads).toBeGreaterThan(0);
      expect(target.classList.contains('driver-active-element')).toBe(true);

      presenter.present(null);
      shadowRootReads = 0;
      document.body.appendChild(document.createElement('div'));
      shadowRoot.appendChild(document.createElement('span'));
      await nextFrame();
      expect(shadowRootReads).toBe(0);

      presenter.present({ copy, step: tutorial.steps[0] });
      await nextFrame();
      expect(shadowRootReads).toBeGreaterThan(0);
      expect(target.classList.contains('driver-active-element')).toBe(true);
    } finally {
      presenter.destroy();
    }
  });

  it('keeps an unanchored blocked step on the same renderable modal', async () => {
    const firstModal = document.createElement('section');
    firstModal.setAttribute('aria-modal', 'true');
    firstModal.setAttribute('role', 'dialog');
    setRect(firstModal, { height: 300, left: 20, top: 20, width: 300 });
    const secondModal = document.createElement('section');
    secondModal.setAttribute('aria-modal', 'true');
    secondModal.setAttribute('role', 'dialog');
    setRect(secondModal, { height: 300, left: 340, top: 20, width: 300 });
    document.body.append(firstModal, secondModal);
    const requestFrame = vi.spyOn(window, 'requestAnimationFrame');
    const presenter = createDriverTutorialPresenter({
      onAcknowledge: vi.fn(),
      onSkip: vi.fn(),
    });

    try {
      presenter.present({ copy, step: tutorial.steps[2] });
      await nextFrame();
      expect(firstModal.getAttribute('aria-modal')).toBe('false');
      expect(secondModal.getAttribute('aria-modal')).toBe('true');

      presenter.refresh();
      await nextFrame();
      await nextFrame();
      expect(firstModal.getAttribute('aria-modal')).toBe('false');
      expect(secondModal.getAttribute('aria-modal')).toBe('true');
      const settledFrameCount = requestFrame.mock.calls.length;

      await nextFrame();

      expect(requestFrame.mock.calls).toHaveLength(settledFrameCount + 2);
    } finally {
      presenter.destroy();
      requestFrame.mockRestore();
    }
  });

  it('releases a class-selected current modal after an exact-value host demotion', async () => {
    const currentModal = document.createElement('section');
    currentModal.className = 'game-modal';
    currentModal.setAttribute('aria-modal', 'true');
    currentModal.setAttribute('role', 'dialog');
    setRect(currentModal, { height: 300, left: 20, top: 20, width: 300 });
    document.body.appendChild(currentModal);
    const presenter = createDriverTutorialPresenter({
      modalSelector: '.game-modal',
      onAcknowledge: vi.fn(),
      onSkip: vi.fn(),
    });
    const replacementModal = document.createElement('section');
    replacementModal.className = 'game-modal';
    replacementModal.setAttribute('aria-modal', 'true');
    replacementModal.setAttribute('role', 'dialog');
    setRect(replacementModal, { height: 300, left: 340, top: 20, width: 300 });
    try {
      presenter.present({ copy, step: tutorial.steps[2] });
      await nextFrame();
      expect(currentModal.getAttribute('aria-modal')).toBe('false');

      currentModal.setAttribute('aria-modal', 'true');
      await nextFrame();
      expect(currentModal.getAttribute('aria-modal')).toBe('false');

      currentModal.setAttribute('aria-modal', 'false');
      document.body.appendChild(replacementModal);
      await nextFrame();

      expect(currentModal.getAttribute('aria-modal')).toBe('false');
      expect(replacementModal.getAttribute('aria-modal')).toBe('false');
    } finally {
      presenter.destroy();
    }
    expect(currentModal.getAttribute('aria-modal')).toBe('false');
    expect(replacementModal.getAttribute('aria-modal')).toBe('true');
  });

  it('ignores shadow modals beneath semantically inactive hosts', async () => {
    for (const inactiveAttribute of ['aria-hidden', 'inert'] as const) {
      const host = document.createElement('div');
      host.setAttribute(inactiveAttribute, inactiveAttribute === 'aria-hidden' ? 'true' : '');
      const shadowRoot = host.attachShadow({ mode: 'open' });
      const shadowModal = document.createElement('section');
      shadowModal.setAttribute('aria-modal', 'true');
      shadowModal.setAttribute('role', 'dialog');
      setRect(shadowModal, { height: 300, left: 20, top: 20, width: 300 });
      const shadowTarget = document.createElement('button');
      shadowTarget.dataset.mpgdTutorialTarget = 'duplicate';
      setRect(shadowTarget, { height: 40, left: 40, top: 40, width: 100 });
      shadowModal.appendChild(shadowTarget);
      shadowRoot.appendChild(shadowModal);
      const visibleModal = document.createElement('section');
      visibleModal.setAttribute('aria-modal', 'true');
      visibleModal.setAttribute('role', 'dialog');
      setRect(visibleModal, { height: 300, left: 340, top: 20, width: 300 });
      document.body.append(host, visibleModal);
      const presenter = createDriverTutorialPresenter({
        onAcknowledge: vi.fn(),
        onSkip: vi.fn(),
        resolveTarget: () => shadowTarget,
      });

      try {
        presenter.present({ copy, step: tutorial.steps[0] });
        await nextFrame();

        expect(shadowModal.getAttribute('aria-modal')).toBe('true');
        expect(visibleModal.getAttribute('aria-modal')).toBe('false');
      } finally {
        presenter.destroy();
        host.remove();
        visibleModal.remove();
      }
    }
  });

  it('ignores slotted modals beneath semantically inactive shadow wrappers', async () => {
    for (const inactiveAttribute of ['aria-hidden', 'inert'] as const) {
      const host = document.createElement('div');
      const shadowRoot = host.attachShadow({ mode: 'open' });
      const inactiveWrapper = document.createElement('div');
      inactiveWrapper.setAttribute(
        inactiveAttribute,
        inactiveAttribute === 'aria-hidden' ? 'true' : '',
      );
      const slot = document.createElement('slot');
      slot.name = 'inactive-modal';
      inactiveWrapper.appendChild(slot);
      shadowRoot.appendChild(inactiveWrapper);
      const slottedModal = document.createElement('section');
      slottedModal.slot = slot.name;
      slottedModal.setAttribute('aria-modal', 'true');
      slottedModal.setAttribute('role', 'dialog');
      setRect(slottedModal, { height: 300, left: 20, top: 20, width: 300 });
      const slottedTarget = document.createElement('button');
      slottedTarget.dataset.mpgdTutorialTarget = 'duplicate';
      setRect(slottedTarget, { height: 40, left: 40, top: 40, width: 100 });
      slottedModal.appendChild(slottedTarget);
      host.appendChild(slottedModal);
      const visibleModal = document.createElement('section');
      visibleModal.setAttribute('aria-modal', 'true');
      visibleModal.setAttribute('role', 'dialog');
      setRect(visibleModal, { height: 300, left: 340, top: 20, width: 300 });
      document.body.append(host, visibleModal);
      const presenter = createDriverTutorialPresenter({
        onAcknowledge: vi.fn(),
        onSkip: vi.fn(),
        resolveTarget: () => slottedTarget,
      });

      try {
        expect(slottedModal.assignedSlot).toBe(slot);
        presenter.present({ copy, step: tutorial.steps[0] });
        await nextFrame();

        expect(slottedModal.getAttribute('aria-modal')).toBe('true');
        expect(visibleModal.getAttribute('aria-modal')).toBe('false');
      } finally {
        presenter.destroy();
        host.remove();
        visibleModal.remove();
      }
    }
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
    const waitingActive = vi.fn();
    const waiting = createDriverTutorialPresenter({
      missingTarget: 'wait',
      onAcknowledge: vi.fn(),
      onActiveChange: waitingActive,
      onSkip: vi.fn(),
    });
    waiting.present({ copy, step: tutorial.steps[0] });
    await nextFrame();
    target.remove();
    await nextFrame();
    expect(document.querySelector('[data-mpgd-tutorial-popover]')).toBeNull();
    expect(document.body.dataset.mpgdTutorialActive).toBeUndefined();
    expect(waitingActive.mock.calls).toEqual([[true], [false]]);
    target = createTarget();
    await nextFrame();
    expect(target.classList.contains('driver-active-element')).toBe(true);
    expect(waitingActive.mock.calls).toEqual([[true], [false], [true]]);
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
    expect(document.getElementById('driver-dummy-element')).toBeNull();
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

  it('rebinds scoped targets when an outer scroll ancestor changes visibility', async () => {
    const scroller = document.createElement('div');
    scroller.style.overflow = 'auto';
    setRect(scroller, { height: 100, left: 0, top: 0, width: 200 });
    const root = document.createElement('div');
    const first = document.createElement('button');
    const second = document.createElement('button');
    first.dataset.mpgdTutorialTarget = 'duplicate';
    second.dataset.mpgdTutorialTarget = 'duplicate';
    let scrolled = false;
    setDynamicRect(first, () => ({ height: 40, left: 20, top: scrolled ? -100 : 20, width: 100 }));
    setDynamicRect(second, () => ({ height: 40, left: 20, top: scrolled ? 20 : 140, width: 100 }));
    root.append(first, second);
    scroller.appendChild(root);
    document.body.appendChild(scroller);
    const presenter = createDriverTutorialPresenter({
      onAcknowledge: vi.fn(),
      onSkip: vi.fn(),
      root,
    });
    presenter.present({ copy, step: tutorial.steps[0] });
    await nextFrame();
    expect(first.classList.contains('driver-active-element')).toBe(true);

    scrolled = true;
    scroller.dispatchEvent(new Event('scroll'));
    await nextFrame();

    expect(first.classList.contains('driver-active-element')).toBe(false);
    expect(second.classList.contains('driver-active-element')).toBe(true);
    presenter.destroy();
  });

  it('reselects duplicates after geometry moves without a root resize', async () => {
    const driverPointerRules = installDriverPointerRules();
    const resizeObserved = new Set<Element>();
    const intersectionObserved = new Set<Element>();
    let intersectionCallback: IntersectionObserverCallback | undefined;
    vi.stubGlobal('ResizeObserver', class {
      disconnect() {
        resizeObserved.clear();
      }

      observe(target: Element) {
        resizeObserved.add(target);
      }

      unobserve(target: Element) {
        resizeObserved.delete(target);
      }
    });
    vi.stubGlobal('IntersectionObserver', class {
      constructor(callback: IntersectionObserverCallback) {
        intersectionCallback = callback;
      }

      disconnect() {
        intersectionObserved.clear();
      }

      observe(target: Element) {
        intersectionObserved.add(target);
      }

      takeRecords(): IntersectionObserverEntry[] {
        return [];
      }

      unobserve(target: Element) {
        intersectionObserved.delete(target);
      }
    });
    const root = document.createElement('div');
    root.style.overflow = 'hidden';
    setRect(root, { height: 100, left: 0, top: 0, width: 200 });
    const first = document.createElement('button');
    const second = document.createElement('button');
    const focusAnchor = document.createElement('button');
    first.dataset.mpgdTutorialTarget = 'duplicate';
    second.dataset.mpgdTutorialTarget = 'duplicate';
    let moved = false;
    let secondVisible = false;
    setDynamicRect(first, () => ({ height: 40, left: 20, top: moved ? -100 : 20, width: 100 }));
    setDynamicRect(second, () => ({
      height: 40,
      left: 20,
      top: moved ? 20 : secondVisible ? 50 : 140,
      width: 100,
    }));
    root.append(first, second);
    document.body.append(root, focusAnchor);
    const onActiveChange = vi.fn();
    const presenter = createDriverTutorialPresenter({
      onAcknowledge: vi.fn(),
      onActiveChange,
      onSkip: vi.fn(),
      root,
    });

    try {
      presenter.present({
        acknowledgeOnTargetClick: true,
        copy,
        step: tutorial.steps[0],
      });
      await nextFrame();
      const initialPopover = document.querySelector('[data-mpgd-tutorial-popover]');
      expect(first.classList.contains('driver-active-element')).toBe(true);
      expect(resizeObserved).toEqual(new Set([root, first, second]));
      expect(intersectionObserved).toEqual(new Set([first, second]));
      focusAnchor.focus();

      intersectionCallback?.(
        [first, second].map((target) => ({ target }) as unknown as IntersectionObserverEntry),
        {} as IntersectionObserver,
      );
      await nextFrame();
      expect(document.querySelector('[data-mpgd-tutorial-popover]')).toBe(initialPopover);
      expect(document.activeElement).toBe(focusAnchor);

      secondVisible = true;
      intersectionCallback?.(
        [second].map((target) => ({ target }) as unknown as IntersectionObserverEntry),
        {} as IntersectionObserver,
      );
      await nextFrame();
      expect(document.querySelector('[data-mpgd-tutorial-popover]')).toBe(initialPopover);
      expect(document.activeElement).toBe(focusAnchor);

      secondVisible = false;
      intersectionCallback?.(
        [second].map((target) => ({ target }) as unknown as IntersectionObserverEntry),
        {} as IntersectionObserver,
      );
      moved = true;
      intersectionCallback?.(
        [first, second].map((target) => ({ target }) as unknown as IntersectionObserverEntry),
        {} as IntersectionObserver,
      );
      await nextFrame();

      expect(document.querySelector('[data-mpgd-tutorial-popover]')).not.toBe(initialPopover);
      expect(first.classList.contains('driver-active-element')).toBe(false);
      expect(second.classList.contains('driver-active-element')).toBe(true);
      expect(onActiveChange).toHaveBeenCalledExactlyOnceWith(true);
    } finally {
      presenter.destroy();
      driverPointerRules.remove();
    }
  });

  it('refreshes a moved active target without recreating its popover or stealing focus', async () => {
    vi.stubGlobal('IntersectionObserver', undefined);
    const target = document.createElement('button');
    const focusAnchor = document.createElement('button');
    target.dataset.mpgdTutorialTarget = 'duplicate';
    let moved = false;
    setDynamicRect(target, () => ({
      height: 40,
      left: moved ? 200 : 20,
      top: moved ? 160 : 20,
      width: 100,
    }));
    document.body.append(target, focusAnchor);
    const onActiveChange = vi.fn();
    const presenter = createDriverTutorialPresenter({
      onAcknowledge: vi.fn(),
      onActiveChange,
      onSkip: vi.fn(),
    });

    try {
      presenter.present({
        acknowledgeOnTargetClick: true,
        copy,
        step: tutorial.steps[0],
      });
      await nextFrame();
      await nextFrame();
      const initialPopover = document.querySelector('[data-mpgd-tutorial-popover]');
      const overlayPath = document.querySelector<SVGPathElement>('.driver-overlay path');
      const initialStage = overlayPath?.getAttribute('d');
      expect(initialStage).not.toBeNull();
      presenter.present({
        acknowledgeOnTargetClick: true,
        copy: { ...copy },
        step: tutorial.steps[0],
      });
      await nextFrame();
      expect(document.querySelector('[data-mpgd-tutorial-popover]')).toBe(initialPopover);
      focusAnchor.focus();
      const setAttribute = overlayPath === null
        ? undefined
        : vi.spyOn(overlayPath, 'setAttribute');

      await nextFrame();
      expect(setAttribute?.mock.calls.some(([attribute]) => attribute === 'd')).toBe(false);

      moved = true;
      await vi.waitFor(() => {
        expect(overlayPath?.getAttribute('d')).not.toBe(initialStage);
      });

      expect(document.querySelector('[data-mpgd-tutorial-popover]')).toBe(initialPopover);
      expect(document.activeElement).toBe(focusAnchor);
      expect(onActiveChange).toHaveBeenCalledExactlyOnceWith(true);
    } finally {
      presenter.destroy();
    }
  });

  it('reselects an offscreen target without IntersectionObserver support', async () => {
    vi.stubGlobal('IntersectionObserver', undefined);
    const first = document.createElement('button');
    const second = document.createElement('button');
    first.dataset.mpgdTutorialTarget = 'duplicate';
    second.dataset.mpgdTutorialTarget = 'duplicate';
    let moved = false;
    setDynamicRect(first, () => ({ height: 40, left: 20, top: moved ? -100 : 20, width: 100 }));
    setDynamicRect(second, () => ({ height: 40, left: 20, top: moved ? 20 : 900, width: 100 }));
    document.body.append(first, second);
    const presenter = createDriverTutorialPresenter({
      onAcknowledge: vi.fn(),
      onSkip: vi.fn(),
    });

    try {
      presenter.present({
        acknowledgeOnTargetClick: true,
        copy,
        step: tutorial.steps[0],
      });
      await nextFrame();
      expect(first.classList.contains('driver-active-element')).toBe(true);
      const initialPopover = document.querySelector('[data-mpgd-tutorial-popover]');

      moved = true;
      await vi.waitFor(() => {
        expect(second.classList.contains('driver-active-element')).toBe(true);
      });

      expect(document.querySelector('[data-mpgd-tutorial-popover]')).not.toBe(initialPopover);
      expect(first.classList.contains('driver-active-element')).toBe(false);
      expect(second.classList.contains('driver-active-element')).toBe(true);
    } finally {
      presenter.destroy();
    }
  });

  it('reselects when a stable target is clipped by a moving ancestor without observers', async () => {
    vi.stubGlobal('IntersectionObserver', undefined);
    const clip = document.createElement('div');
    clip.style.overflow = 'hidden';
    const first = document.createElement('button');
    const second = document.createElement('button');
    first.dataset.mpgdTutorialTarget = 'duplicate';
    second.dataset.mpgdTutorialTarget = 'duplicate';
    let clipped = false;
    setDynamicRect(clip, () => ({
      height: 80,
      left: clipped ? 300 : 0,
      top: 0,
      width: 180,
    }));
    setRect(first, { height: 40, left: 20, top: 20, width: 100 });
    setRect(second, { height: 40, left: 220, top: 20, width: 100 });
    clip.appendChild(first);
    document.body.append(clip, second);
    const presenter = createDriverTutorialPresenter({
      onAcknowledge: vi.fn(),
      onSkip: vi.fn(),
    });

    try {
      presenter.present({
        acknowledgeOnTargetClick: true,
        copy,
        step: tutorial.steps[0],
      });
      await nextFrame();
      expect(first.classList.contains('driver-active-element')).toBe(true);

      clipped = true;
      await vi.waitFor(() => {
        expect(second.classList.contains('driver-active-element')).toBe(true);
      });
    } finally {
      presenter.destroy();
    }
  });

  it('keeps a visible target stable on scroll and recreates only after it leaves view', async () => {
    const driverPointerRules = installDriverPointerRules();
    const scroller = document.createElement('div');
    scroller.style.overflow = 'auto';
    setRect(scroller, { height: 100, left: 0, top: 0, width: 200 });
    const first = document.createElement('button');
    const second = document.createElement('button');
    const outside = document.createElement('button');
    first.dataset.mpgdTutorialTarget = 'duplicate';
    second.dataset.mpgdTutorialTarget = 'duplicate';
    let scrolled = false;
    setDynamicRect(first, () => ({ height: 40, left: 20, top: scrolled ? -100 : 20, width: 100 }));
    setDynamicRect(second, () => ({ height: 40, left: 20, top: scrolled ? 20 : 140, width: 100 }));
    scroller.append(first, second);
    document.body.append(scroller, outside);
    const onActiveChange = vi.fn();
    const presenter = createDriverTutorialPresenter({
      onAcknowledge: vi.fn(),
      onActiveChange,
      onSkip: vi.fn(),
    });

    try {
      presenter.present({
        acknowledgeOnTargetClick: true,
        copy,
        step: tutorial.steps[0],
      });
      await nextFrame();
      const initialPopover = document.querySelector('[data-mpgd-tutorial-popover]');
      outside.focus();

      scroller.dispatchEvent(new Event('scroll'));
      await nextFrame();

      expect(document.querySelector('[data-mpgd-tutorial-popover]')).toBe(initialPopover);
      expect(document.activeElement).toBe(outside);
      expect(first.classList.contains('driver-active-element')).toBe(true);

      scrolled = true;
      scroller.dispatchEvent(new Event('scroll'));
      await nextFrame();

      expect(document.querySelector('[data-mpgd-tutorial-popover]')).not.toBe(initialPopover);
      expect(first.classList.contains('driver-active-element')).toBe(false);
      expect(second.classList.contains('driver-active-element')).toBe(true);
      expect(onActiveChange).toHaveBeenCalledExactlyOnceWith(true);
    } finally {
      presenter.destroy();
      driverPointerRules.remove();
    }
  });

  it('rebinds scoped targets when an outer ancestor class changes visibility', async () => {
    const style = document.createElement('style');
    style.textContent = '.show-second .first-duplicate { opacity: 0; }';
    const outer = document.createElement('div');
    const root = document.createElement('div');
    const first = document.createElement('button');
    const second = document.createElement('button');
    first.className = 'first-duplicate';
    first.dataset.mpgdTutorialTarget = 'duplicate';
    second.dataset.mpgdTutorialTarget = 'duplicate';
    setRect(first, { height: 40, left: 20, top: 20, width: 100 });
    setRect(second, { height: 40, left: 20, top: 80, width: 100 });
    root.append(first, second);
    outer.appendChild(root);
    document.body.append(style, outer);
    const presenter = createDriverTutorialPresenter({
      onAcknowledge: vi.fn(),
      onSkip: vi.fn(),
      root,
    });
    presenter.present({ copy, step: tutorial.steps[0] });
    await nextFrame();
    expect(first.classList.contains('driver-active-element')).toBe(true);

    outer.classList.add('show-second');
    await nextFrame();

    expect(first.classList.contains('driver-active-element')).toBe(false);
    expect(second.classList.contains('driver-active-element')).toBe(true);
    presenter.destroy();
  });

  it('rebinds scoped targets on a layout viewport resize without visualViewport', async () => {
    vi.stubGlobal('innerWidth', 640);
    vi.stubGlobal('visualViewport', undefined);
    const addEventListener = vi.spyOn(window, 'addEventListener');
    const removeEventListener = vi.spyOn(window, 'removeEventListener');
    const root = document.createElement('div');
    const first = document.createElement('button');
    const second = document.createElement('button');
    first.dataset.mpgdTutorialTarget = 'duplicate';
    second.dataset.mpgdTutorialTarget = 'duplicate';
    setRect(first, { height: 40, left: 420, top: 20, width: 100 });
    setRect(second, { height: 40, left: 20, top: 80, width: 100 });
    root.append(first, second);
    document.body.appendChild(root);
    const presenter = createDriverTutorialPresenter({
      onAcknowledge: vi.fn(),
      onSkip: vi.fn(),
      root,
    });
    const resizeListener = addEventListener.mock.calls.find(([type]) => type === 'resize')?.[1];

    try {
      expect(resizeListener).toEqual(expect.any(Function));
      presenter.present({ copy, step: tutorial.steps[0] });
      await nextFrame();
      expect(first.classList.contains('driver-active-element')).toBe(true);

      vi.stubGlobal('innerWidth', 320);
      window.dispatchEvent(new Event('resize'));
      await nextFrame();

      expect(first.classList.contains('driver-active-element')).toBe(false);
      expect(second.classList.contains('driver-active-element')).toBe(true);
      presenter.destroy();
      expect(removeEventListener).toHaveBeenCalledWith('resize', resizeListener);
    } finally {
      presenter.destroy();
      addEventListener.mockRestore();
      removeEventListener.mockRestore();
    }
  });

  it('settles Driver-owned target ARIA writes without a refresh loop', async () => {
    const target = document.createElement('button');
    target.dataset.mpgdTutorialTarget = 'duplicate';
    target.setAttribute('aria-controls', 'original-panel');
    target.setAttribute('aria-expanded', 'false');
    target.setAttribute('aria-haspopup', 'menu');
    setRect(target, { height: 40, left: 20, top: 20, width: 100 });
    document.body.appendChild(target);
    const requestFrame = vi.spyOn(window, 'requestAnimationFrame');
    const presenter = createDriverTutorialPresenter({
      onAcknowledge: vi.fn(),
      onSkip: vi.fn(),
    });

    try {
      presenter.present({ copy, step: tutorial.steps[0] });
      await nextFrame();
      await nextFrame();
      const settledFrameCount = requestFrame.mock.calls.length;

      await nextFrame();

      expect(requestFrame.mock.calls).toHaveLength(settledFrameCount + 2);
    } finally {
      presenter.destroy();
      requestFrame.mockRestore();
    }
  });

  it('keeps unrelated host mutations on the stable refresh path', async () => {
    const target = document.createElement('button');
    target.dataset.mpgdTutorialTarget = 'duplicate';
    setRect(target, { height: 40, left: 20, top: 20, width: 100 });
    document.body.appendChild(target);
    const requestFrame = vi.spyOn(window, 'requestAnimationFrame');
    const onActiveChange = vi.fn((active: boolean) => {
      if (active) {
        document.body.appendChild(document.createElement('output'));
      }
    });
    const presenter = createDriverTutorialPresenter({
      onAcknowledge: vi.fn(),
      onActiveChange,
      onSkip: vi.fn(),
    });

    try {
      presenter.present({
        acknowledgeOnTargetClick: true,
        copy,
        step: tutorial.steps[0],
      });
      await nextFrame();
      const initialPopover = document.querySelector('[data-mpgd-tutorial-popover]');
      const settledFrameCount = requestFrame.mock.calls.length;

      for (let index = 0; index < 20; index += 1) {
        const tick = document.createElement('span');
        tick.dataset.tick = String(index);
        document.body.appendChild(tick);
      }

      await nextFrame();

      expect(document.querySelector('[data-mpgd-tutorial-popover]')).toBe(initialPopover);
      expect(onActiveChange).toHaveBeenCalledExactlyOnceWith(true);
      expect(requestFrame.mock.calls.length).toBeLessThanOrEqual(settledFrameCount + 5);
    } finally {
      presenter.destroy();
      requestFrame.mockRestore();
    }
  });

  it('reports a custom target resolver failure without escaping the frame', async () => {
    const error = new Error('resolver failed');
    const reporterError = new Error('reporter failed');
    const onError = vi.fn(() => {
      throw reporterError;
    });
    const windowErrors: unknown[] = [];
    const recordWindowError = (event: ErrorEvent): void => {
      windowErrors.push(event.error);
      event.preventDefault();
    };
    window.addEventListener('error', recordWindowError);
    const presenter = createDriverTutorialPresenter({
      onAcknowledge: vi.fn(),
      onError,
      onSkip: vi.fn(),
      resolveTarget: () => {
        throw error;
      },
    });

    try {
      presenter.present({ copy, step: tutorial.steps[0] });
      await nextFrame();

      expect(onError).toHaveBeenCalledExactlyOnceWith(error);
      expect(windowErrors).toEqual([]);
      expect(document.querySelector('[data-mpgd-tutorial-popover]')).toBeNull();
    } finally {
      presenter.destroy();
      window.removeEventListener('error', recordWindowError);
    }
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

  it('keeps Next available when a custom resolver returns an inert target', async () => {
    const inertHost = document.createElement('div');
    const target = document.createElement('button');
    inertHost.inert = true;
    target.dataset.mpgdTutorialTarget = 'duplicate';
    setRect(target, { height: 40, left: 20, top: 20, width: 100 });
    inertHost.appendChild(target);
    document.body.appendChild(inertHost);
    const presenter = createDriverTutorialPresenter({
      onAcknowledge: vi.fn(),
      onSkip: vi.fn(),
      resolveTarget: () => target,
    });

    try {
      presenter.present({
        acknowledgeOnTargetClick: true,
        copy,
        step: tutorial.steps[0],
      });
      await nextFrame();

      expect(document.querySelector<HTMLElement>('[data-mpgd-tutorial-next]')?.style.display)
        .toBe('block');
    } finally {
      presenter.destroy();
    }
  });

  it('restarts a preferred custom target only when resolver identity changes', async () => {
    const driverPointerRules = installDriverPointerRules();
    const root = document.createElement('section');
    const marker = document.createElement('div');
    const first = document.createElement('button');
    const second = document.createElement('button');
    const focusAnchor = document.createElement('button');
    first.dataset.mpgdTutorialTarget = 'duplicate';
    second.dataset.mpgdTutorialTarget = 'duplicate';
    setRect(first, { height: 40, left: 20, top: 20, width: 100 });
    setRect(second, { height: 40, left: 140, top: 20, width: 100 });
    root.append(marker, first, second);
    document.body.append(root, focusAnchor);
    const onActiveChange = vi.fn();
    const resolveTarget = vi.fn(() => (
      marker.dataset.selected === 'second' ? second : first
    ));
    const presenter = createDriverTutorialPresenter({
      onAcknowledge: vi.fn(),
      onActiveChange,
      onSkip: vi.fn(),
      resolveTarget,
      root,
    });

    try {
      presenter.present({
        acknowledgeOnTargetClick: true,
        copy,
        step: tutorial.steps[0],
      });
      await nextFrame();
      const initialPopover = document.querySelector('[data-mpgd-tutorial-popover]');
      focusAnchor.focus();

      marker.appendChild(document.createElement('span'));
      await nextFrame();
      expect(document.querySelector('[data-mpgd-tutorial-popover]')).toBe(initialPopover);
      expect(document.activeElement).toBe(focusAnchor);
      expect(first.classList.contains('driver-active-element')).toBe(true);

      marker.dataset.selected = 'second';
      await nextFrame();
      expect(document.querySelector('[data-mpgd-tutorial-popover]')).not.toBe(initialPopover);
      expect(first.classList.contains('driver-active-element')).toBe(false);
      expect(second.classList.contains('driver-active-element')).toBe(true);
      expect(onActiveChange).toHaveBeenCalledExactlyOnceWith(true);
      expect(resolveTarget.mock.calls.length).toBeGreaterThanOrEqual(3);
    } finally {
      presenter.destroy();
      driverPointerRules.remove();
    }
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
    await clickAndFlush(target);

    expect(onAcknowledge).toHaveBeenCalledExactlyOnceWith('blocked');
    presenter.destroy();
  });

  it('acknowledges a target click inside an open shadow root exactly once', async () => {
    const host = document.createElement('div');
    const shadowRoot = host.attachShadow({ mode: 'open' });
    const target = document.createElement('button');
    target.dataset.mpgdTutorialTarget = 'duplicate';
    setRect(target, { height: 40, left: 20, top: 20, width: 100 });
    shadowRoot.appendChild(target);
    document.body.appendChild(host);
    const onAcknowledge = vi.fn();
    const presenter = createDriverTutorialPresenter({
      onAcknowledge,
      onSkip: vi.fn(),
      resolveTarget: () => target,
    });

    try {
      presenter.present({
        acknowledgeOnTargetClick: true,
        copy,
        step: tutorial.steps[0],
      });
      await nextFrame();

      await clickAndFlush(target);

      expect(onAcknowledge).toHaveBeenCalledExactlyOnceWith('blocked');
    } finally {
      presenter.destroy();
    }
  });

  it('recreates an owned shadow pointer rule without overwriting host styles', async () => {
    const driverPointerRules = installDriverPointerRules();
    const host = document.createElement('div');
    const shadowRoot = host.attachShadow({ mode: 'open' });
    const target = document.createElement('button');
    target.dataset.mpgdTutorialTarget = 'duplicate';
    setRect(target, { height: 40, left: 20, top: 20, width: 100 });
    shadowRoot.appendChild(target);
    document.body.appendChild(host);
    const onAcknowledge = vi.fn();
    const presenter = createDriverTutorialPresenter({
      onAcknowledge,
      onSkip: vi.fn(),
    });

    try {
      presenter.present({
        acknowledgeOnTargetClick: true,
        copy,
        step: tutorial.steps[0],
      });
      await nextFrame();
      const firstPointerStyle = [...shadowRoot.querySelectorAll('style')].find((style) => (
        style.textContent?.includes('.driver-active-element:not(.driver-no-interaction)') === true
      ));
      expect(firstPointerStyle).toBeDefined();
      expect(target.style.getPropertyValue('pointer-events')).toBe('');
      expect(getComputedStyle(target).pointerEvents).toBe('auto');
      expect(firstPointerStyle?.textContent).toContain('position: relative !important;');
      expect(firstPointerStyle?.textContent).toContain('z-index: 1000000001 !important;');

      target.style.pointerEvents = 'none';
      await nextFrame();
      expect(target.style.pointerEvents).toBe('none');
      expect(firstPointerStyle?.isConnected).toBe(false);
      expect(shadowRoot.querySelector('style')).toBeNull();
      expect(document.querySelector<HTMLElement>('[data-mpgd-tutorial-next]')?.style.display)
        .toBe('block');

      target.style.removeProperty('pointer-events');
      await nextFrame();
      expect(target.style.getPropertyValue('pointer-events')).toBe('');
      expect(shadowRoot.querySelector('style')).not.toBeNull();
      expect(getComputedStyle(target).pointerEvents).toBe('auto');
      await clickAndFlush(target);
      expect(onAcknowledge).toHaveBeenCalledExactlyOnceWith('blocked');
    } finally {
      presenter.destroy();
      driverPointerRules.remove();
    }

    expect(target.style.getPropertyValue('pointer-events')).toBe('');
    expect(shadowRoot.querySelector('style')).toBeNull();
  });

  it('keeps Next when a lower shadow host fails document hit testing', async () => {
    const driverPointerRules = installDriverPointerRules();
    const host = document.createElement('div');
    host.style.position = 'relative';
    host.style.zIndex = '0';
    const shadowRoot = host.attachShadow({ mode: 'open' });
    const target = document.createElement('button');
    target.dataset.mpgdTutorialTarget = 'duplicate';
    setRect(target, { height: 40, left: 20, top: 20, width: 100 });
    shadowRoot.appendChild(target);
    document.body.appendChild(host);
    const elementFromPointDescriptor = Object.getOwnPropertyDescriptor(
      document,
      'elementFromPoint',
    );
    let hitTestCount = 0;
    Object.defineProperty(document, 'elementFromPoint', {
      configurable: true,
      value: () => {
        hitTestCount += 1;
        return document.querySelector('.driver-overlay');
      },
    });
    Object.defineProperty(shadowRoot, 'elementFromPoint', {
      configurable: true,
      value: () => target,
    });
    const onAcknowledge = vi.fn();
    const presenter = createDriverTutorialPresenter({
      onAcknowledge,
      onSkip: vi.fn(),
    });

    try {
      presenter.present({
        acknowledgeOnTargetClick: true,
        copy,
        step: tutorial.steps[0],
      });
      await nextFrame();

      expect(hitTestCount).toBeGreaterThanOrEqual(1);
      expect(target.classList.contains('driver-no-interaction')).toBe(true);
      const next = document.querySelector<HTMLButtonElement>('[data-mpgd-tutorial-next]');
      expect(next?.style.display).toBe('block');
      target.click();
      expect(onAcknowledge).not.toHaveBeenCalled();
      next?.click();
      expect(onAcknowledge).toHaveBeenCalledExactlyOnceWith('blocked');
    } finally {
      presenter.destroy();
      driverPointerRules.remove();

      if (elementFromPointDescriptor === undefined) {
        Reflect.deleteProperty(document, 'elementFromPoint');
      } else {
        Object.defineProperty(document, 'elementFromPoint', elementFromPointDescriptor);
      }
    }
  });

  it('lets a shadow action target receive input when the overlay wins hit testing', async () => {
    const host = document.createElement('div');
    const shadowRoot = host.attachShadow({ mode: 'open' });
    const target = document.createElement('button');
    target.dataset.mpgdTutorialTarget = 'choice';
    setRect(target, { height: 40, left: 20, top: 20, width: 100 });
    shadowRoot.appendChild(target);
    document.body.appendChild(host);
    const elementFromPointDescriptor = Object.getOwnPropertyDescriptor(
      document,
      'elementFromPoint',
    );
    let hitTestCount = 0;
    Object.defineProperty(document, 'elementFromPoint', {
      configurable: true,
      value: () => {
        hitTestCount += 1;
        return document.querySelector('.driver-overlay');
      },
    });
    Object.defineProperty(shadowRoot, 'elementFromPoint', {
      configurable: true,
      value: () => target,
    });
    const presenter = createDriverTutorialPresenter({
      onAcknowledge: vi.fn(),
      onSkip: vi.fn(),
    });

    try {
      presenter.present({ copy, step: tutorial.steps[1] });
      await nextFrame();
      await nextFrame();

      expect(hitTestCount).toBeGreaterThanOrEqual(1);
      const overlay = document.querySelector<SVGElement>('.driver-overlay');
      expect(overlay?.style.pointerEvents).toBe('none');
      expect(document.querySelector<HTMLButtonElement>('[data-mpgd-tutorial-next]')?.style.display)
        .not.toBe('block');
      expect(document.querySelectorAll('[data-mpgd-tutorial-outside-blocker]')).toHaveLength(4);
    } finally {
      presenter.destroy();
      expect(document.querySelector('[data-mpgd-tutorial-outside-blocker]')).toBeNull();

      if (elementFromPointDescriptor === undefined) {
        Reflect.deleteProperty(document, 'elementFromPoint');
      } else {
        Object.defineProperty(document, 'elementFromPoint', elementFromPointDescriptor);
      }
    }
  });

  it('rechecks shadow hit testing after a stable host mutation', async () => {
    const host = document.createElement('div');
    const shadowRoot = host.attachShadow({ mode: 'open' });
    const target = document.createElement('button');
    target.dataset.mpgdTutorialTarget = 'duplicate';
    setRect(target, { height: 40, left: 20, top: 20, width: 100 });
    shadowRoot.appendChild(target);
    document.body.appendChild(host);
    const elementFromPointDescriptor = Object.getOwnPropertyDescriptor(
      document,
      'elementFromPoint',
    );
    let obstructed = false;
    Object.defineProperty(document, 'elementFromPoint', {
      configurable: true,
      value: () => obstructed ? document.querySelector('.driver-overlay') : host,
    });
    Object.defineProperty(shadowRoot, 'elementFromPoint', {
      configurable: true,
      value: () => target,
    });
    const presenter = createDriverTutorialPresenter({
      onAcknowledge: vi.fn(),
      onSkip: vi.fn(),
    });

    try {
      presenter.present({
        acknowledgeOnTargetClick: true,
        copy,
        step: tutorial.steps[0],
      });
      await nextFrame();
      expect(document.querySelector<HTMLElement>('[data-mpgd-tutorial-next]')?.style.display)
        .not.toBe('block');

      obstructed = true;
      document.body.appendChild(document.createElement('div'));
      await nextFrame();

      expect(document.querySelector<HTMLElement>('[data-mpgd-tutorial-next]')?.style.display)
        .toBe('block');
    } finally {
      presenter.destroy();

      if (elementFromPointDescriptor === undefined) {
        Reflect.deleteProperty(document, 'elementFromPoint');
      } else {
        Object.defineProperty(document, 'elementFromPoint', elementFromPointDescriptor);
      }
    }
  });

  it('does not open a target hole for a non-Driver occluder', async () => {
    const host = document.createElement('div');
    const shadowRoot = host.attachShadow({ mode: 'open' });
    const target = document.createElement('button');
    const occluder = document.createElement('div');
    target.dataset.mpgdTutorialTarget = 'choice';
    setRect(target, { height: 40, left: 20, top: 20, width: 100 });
    shadowRoot.appendChild(target);
    document.body.append(host, occluder);
    const elementFromPointDescriptor = Object.getOwnPropertyDescriptor(
      document,
      'elementFromPoint',
    );
    Object.defineProperty(document, 'elementFromPoint', {
      configurable: true,
      value: () => occluder,
    });
    const presenter = createDriverTutorialPresenter({
      onAcknowledge: vi.fn(),
      onSkip: vi.fn(),
    });

    try {
      presenter.present({ copy, step: tutorial.steps[1] });
      await nextFrame();

      expect(document.querySelector<SVGElement>('.driver-overlay')?.style.pointerEvents)
        .not.toBe('none');
      expect(document.querySelector('[data-mpgd-tutorial-outside-blocker]')).toBeNull();
    } finally {
      presenter.destroy();

      if (elementFromPointDescriptor === undefined) {
        Reflect.deleteProperty(document, 'elementFromPoint');
      } else {
        Object.defineProperty(document, 'elementFromPoint', elementFromPointDescriptor);
      }
    }
  });

  it('acknowledges after an earlier host action even when it stops bubble propagation', async () => {
    const host = document.createElement('div');
    const shadowRoot = host.attachShadow({ mode: 'open' });
    const target = document.createElement('button');
    target.dataset.mpgdTutorialTarget = 'duplicate';
    setRect(target, { height: 40, left: 20, top: 20, width: 100 });
    shadowRoot.appendChild(target);
    document.body.appendChild(host);
    const events: string[] = [];
    target.addEventListener('click', (event) => {
      events.push('host');
      event.stopImmediatePropagation();
    });
    const onAcknowledge = vi.fn(() => events.push('acknowledge'));
    const presenter = createDriverTutorialPresenter({
      onAcknowledge,
      onSkip: vi.fn(),
    });

    try {
      presenter.present({
        acknowledgeOnTargetClick: true,
        copy,
        step: tutorial.steps[0],
      });
      await nextFrame();

      target.click();
      expect(events).toEqual(['host']);
      await Promise.resolve();

      expect(onAcknowledge).toHaveBeenCalledExactlyOnceWith('blocked');
      expect(events).toEqual(['host', 'acknowledge']);
    } finally {
      presenter.destroy();
    }
  });

  it('preserves a valid target click when its host handler disables further interaction', async () => {
    const target = document.createElement('button');
    target.dataset.mpgdTutorialTarget = 'duplicate';
    setRect(target, { height: 40, left: 20, top: 20, width: 100 });
    document.body.appendChild(target);
    target.addEventListener('click', () => {
      target.disabled = true;
      target.style.pointerEvents = 'none';
    });
    const onAcknowledge = vi.fn();
    const presenter = createDriverTutorialPresenter({
      onAcknowledge,
      onSkip: vi.fn(),
    });

    try {
      presenter.present({
        acknowledgeOnTargetClick: true,
        copy,
        step: tutorial.steps[0],
      });
      await nextFrame();

      target.click();
      expect(target.disabled).toBe(true);
      expect(target.style.pointerEvents).toBe('none');
      expect(onAcknowledge).not.toHaveBeenCalled();
      await Promise.resolve();

      expect(onAcknowledge).toHaveBeenCalledExactlyOnceWith('blocked');
    } finally {
      presenter.destroy();
    }
  });

  it('drops a deferred target acknowledgement after the host changes presentation', async () => {
    const target = document.createElement('button');
    target.dataset.mpgdTutorialTarget = 'duplicate';
    setRect(target, { height: 40, left: 20, top: 20, width: 100 });
    document.body.appendChild(target);
    const onAcknowledge = vi.fn();
    const presenter = createDriverTutorialPresenter({
      onAcknowledge,
      onSkip: vi.fn(),
    });
    target.addEventListener('click', () => presenter.present(null));

    try {
      presenter.present({
        acknowledgeOnTargetClick: true,
        copy,
        step: tutorial.steps[0],
      });
      await nextFrame();

      target.click();
      await Promise.resolve();

      expect(onAcknowledge).not.toHaveBeenCalled();
      expect(document.querySelector('[data-mpgd-tutorial-popover]')).toBeNull();
    } finally {
      presenter.destroy();
    }
  });

  it('acknowledges an explicit pointer-enabled target beneath a pointer-disabled ancestor', async () => {
    const driverPointerRules = installDriverPointerRules();
    const wrapper = document.createElement('div');
    wrapper.style.pointerEvents = 'none';
    const target = document.createElement('button');
    target.dataset.mpgdTutorialTarget = 'duplicate';
    target.style.pointerEvents = 'auto';
    setRect(target, { height: 40, left: 20, top: 20, width: 100 });
    wrapper.appendChild(target);
    document.body.appendChild(wrapper);
    const onAcknowledge = vi.fn();
    const presenter = createDriverTutorialPresenter({
      onAcknowledge,
      onSkip: vi.fn(),
    });

    try {
      presenter.present({
        acknowledgeOnTargetClick: true,
        copy,
        step: tutorial.steps[0],
      });
      await nextFrame();

      expect(getComputedStyle(wrapper).pointerEvents).toBe('none');
      expect(getComputedStyle(target).pointerEvents).toBe('auto');
      expect(document.activeElement).toBe(
        document.querySelector('[data-mpgd-tutorial-skip]'),
      );
      await clickAndFlush(target);
      expect(onAcknowledge).toHaveBeenCalledExactlyOnceWith('blocked');
    } finally {
      presenter.destroy();
      driverPointerRules.remove();
    }
  });

  it('cleans target-click bindings across rebind and destroy without duplicate callbacks', async () => {
    const driverPointerRules = installDriverPointerRules(`
      .test-pointer-disabled { pointer-events: none; }
    `);
    const first = document.createElement('button');
    first.dataset.mpgdTutorialTarget = 'duplicate';
    setRect(first, { height: 40, left: 20, top: 20, width: 100 });
    document.body.appendChild(first);
    const onAcknowledge = vi.fn();
    const presenter = createDriverTutorialPresenter({
      onAcknowledge,
      onSkip: vi.fn(),
    });

    try {
      presenter.present({
        acknowledgeOnTargetClick: true,
        copy,
        step: tutorial.steps[0],
      });
      await nextFrame();

      first.style.display = 'none';
      const blockedReplacement = document.createElement('button');
      blockedReplacement.className = 'test-pointer-disabled';
      blockedReplacement.dataset.mpgdTutorialTarget = 'duplicate';
      setRect(blockedReplacement, { height: 40, left: 140, top: 20, width: 100 });
      const replacement = document.createElement('button');
      replacement.dataset.mpgdTutorialTarget = 'duplicate';
      setRect(replacement, { height: 40, left: 260, top: 20, width: 100 });
      document.body.append(blockedReplacement, replacement);
      await nextFrame();

      expect(blockedReplacement.classList.contains('driver-active-element')).toBe(false);
      expect(getComputedStyle(replacement).pointerEvents).toBe('auto');
      expect(replacement.classList.contains('driver-active-element')).toBe(true);
      first.click();
      expect(onAcknowledge).not.toHaveBeenCalled();
      await clickAndFlush(replacement);
      expect(onAcknowledge).toHaveBeenCalledExactlyOnceWith('blocked');

      presenter.destroy();
      replacement.click();
      expect(onAcknowledge).toHaveBeenCalledExactlyOnceWith('blocked');
    } finally {
      presenter.destroy();
      driverPointerRules.remove();
    }
  });

  it('rebinds target-click acknowledgement from a disabled duplicate to an enabled one', async () => {
    const disabledTarget = document.createElement('button');
    disabledTarget.disabled = true;
    disabledTarget.dataset.mpgdTutorialTarget = 'duplicate';
    setRect(disabledTarget, { height: 40, left: 20, top: 20, width: 100 });
    document.body.appendChild(disabledTarget);
    const onAcknowledge = vi.fn();
    const presenter = createDriverTutorialPresenter({
      onAcknowledge,
      onSkip: vi.fn(),
    });

    try {
      presenter.present({
        acknowledgeOnTargetClick: true,
        copy,
        step: tutorial.steps[0],
      });
      await nextFrame();
      expect(disabledTarget.classList.contains('driver-active-element')).toBe(true);
      expect(document.querySelector<HTMLElement>('[data-mpgd-tutorial-next]')?.style.display)
        .toBe('block');

      const enabledTarget = document.createElement('button');
      enabledTarget.dataset.mpgdTutorialTarget = 'duplicate';
      setRect(enabledTarget, { height: 40, left: 140, top: 20, width: 100 });
      document.body.appendChild(enabledTarget);
      await nextFrame();

      expect(disabledTarget.classList.contains('driver-active-element')).toBe(false);
      expect(enabledTarget.classList.contains('driver-active-element')).toBe(true);
      await clickAndFlush(enabledTarget);
      expect(onAcknowledge).toHaveBeenCalledExactlyOnceWith('blocked');
    } finally {
      presenter.destroy();
    }
  });

  it('keeps Next available when the only target-click acknowledgement target is disabled', async () => {
    const disabledTarget = document.createElement('button');
    disabledTarget.disabled = true;
    disabledTarget.dataset.mpgdTutorialTarget = 'duplicate';
    setRect(disabledTarget, { height: 40, left: 20, top: 20, width: 100 });
    document.body.appendChild(disabledTarget);
    const onAcknowledge = vi.fn();
    const presenter = createDriverTutorialPresenter({
      onAcknowledge,
      onSkip: vi.fn(),
    });

    try {
      presenter.present({
        acknowledgeOnTargetClick: true,
        copy,
        step: tutorial.steps[0],
      });
      await nextFrame();

      disabledTarget.click();
      expect(onAcknowledge).not.toHaveBeenCalled();
      const next = document.querySelector<HTMLButtonElement>('[data-mpgd-tutorial-next]');
      expect(next).not.toBeNull();
      expect(document.activeElement).toBe(next);
      next?.click();
      expect(onAcknowledge).toHaveBeenCalledExactlyOnceWith('blocked');
    } finally {
      presenter.destroy();
    }
  });

  it('keeps Next available when target clicks are blocked by pointer events', async () => {
    const driverPointerRules = installDriverPointerRules(`
      .test-pointer-disabled { pointer-events: none; }
    `);
    const target = document.createElement('button');
    target.className = 'test-pointer-disabled';
    target.dataset.mpgdTutorialTarget = 'duplicate';
    setRect(target, { height: 40, left: 20, top: 20, width: 100 });
    document.body.appendChild(target);
    const onAcknowledge = vi.fn();
    const presenter = createDriverTutorialPresenter({
      onAcknowledge,
      onSkip: vi.fn(),
    });

    try {
      presenter.present({
        acknowledgeOnTargetClick: true,
        copy,
        step: tutorial.steps[0],
      });
      await nextFrame();

      expect(getComputedStyle(target).pointerEvents).toBe('none');
      await clickAndFlush(target);
      expect(onAcknowledge).not.toHaveBeenCalled();
      const next = document.querySelector<HTMLButtonElement>('[data-mpgd-tutorial-next]');
      expect(next?.style.display).toBe('block');
      next?.click();
      expect(onAcknowledge).toHaveBeenCalledExactlyOnceWith('blocked');
    } finally {
      presenter.destroy();
      driverPointerRules.remove();
    }
  });

  it('restarts when an arbitrary ancestor attribute changes target pointer eligibility', async () => {
    const driverPointerRules = installDriverPointerRules(`
      [data-mode="busy"] .attribute-controlled { pointer-events: none; }
    `);
    const wrapper = document.createElement('div');
    const target = document.createElement('button');
    target.className = 'attribute-controlled';
    target.dataset.mpgdTutorialTarget = 'duplicate';
    setRect(target, { height: 40, left: 20, top: 20, width: 100 });
    wrapper.appendChild(target);
    document.body.appendChild(wrapper);
    const onActiveChange = vi.fn();
    const presenter = createDriverTutorialPresenter({
      onAcknowledge: vi.fn(),
      onActiveChange,
      onSkip: vi.fn(),
    });

    try {
      presenter.present({
        acknowledgeOnTargetClick: true,
        copy,
        step: tutorial.steps[0],
      });
      await nextFrame();
      const interactivePopover = document.querySelector('[data-mpgd-tutorial-popover]');

      wrapper.dataset.mode = 'busy';
      await nextFrame();
      const blockedPopover = document.querySelector('[data-mpgd-tutorial-popover]');
      expect(blockedPopover).not.toBe(interactivePopover);
      expect(target.classList.contains('driver-no-interaction')).toBe(true);
      expect(document.querySelector<HTMLElement>('[data-mpgd-tutorial-next]')?.style.display)
        .toBe('block');

      delete wrapper.dataset.mode;
      await nextFrame();
      expect(document.querySelector('[data-mpgd-tutorial-popover]')).not.toBe(blockedPopover);
      expect(target.classList.contains('driver-no-interaction')).toBe(false);
      expect(onActiveChange).toHaveBeenCalledExactlyOnceWith(true);
    } finally {
      presenter.destroy();
      driverPointerRules.remove();
    }
  });

  it('restarts for a sibling selector without treating another subtree as relevant', async () => {
    const driverPointerRules = installDriverPointerRules(`
      [data-mode="busy"] + .sibling-controlled { pointer-events: none !important; }
    `);
    const group = document.createElement('div');
    const mode = document.createElement('span');
    const target = document.createElement('button');
    const unrelatedGroup = document.createElement('div');
    const unrelated = document.createElement('span');
    const focusAnchor = document.createElement('button');
    target.className = 'sibling-controlled';
    target.dataset.mpgdTutorialTarget = 'duplicate';
    setRect(target, { height: 40, left: 20, top: 20, width: 100 });
    group.append(mode, target);
    unrelatedGroup.appendChild(unrelated);
    document.body.append(group, unrelatedGroup, focusAnchor);
    const onActiveChange = vi.fn();
    const presenter = createDriverTutorialPresenter({
      onAcknowledge: vi.fn(),
      onActiveChange,
      onSkip: vi.fn(),
    });

    try {
      presenter.present({
        acknowledgeOnTargetClick: true,
        copy,
        step: tutorial.steps[0],
      });
      await nextFrame();
      const interactivePopover = document.querySelector('[data-mpgd-tutorial-popover]');
      focusAnchor.focus();

      unrelated.dataset.mode = 'busy';
      await nextFrame();
      expect(document.querySelector('[data-mpgd-tutorial-popover]')).toBe(interactivePopover);
      expect(document.activeElement).toBe(focusAnchor);

      mode.dataset.mode = 'busy';
      await nextFrame();
      const blockedPopover = document.querySelector('[data-mpgd-tutorial-popover]');
      expect(blockedPopover).not.toBe(interactivePopover);
      expect(target.classList.contains('driver-no-interaction')).toBe(true);
      expect(document.querySelector<HTMLElement>('[data-mpgd-tutorial-next]')?.style.display)
        .toBe('block');

      delete mode.dataset.mode;
      await nextFrame();
      expect(document.querySelector('[data-mpgd-tutorial-popover]')).not.toBe(blockedPopover);
      expect(target.classList.contains('driver-no-interaction')).toBe(false);
      expect(onActiveChange).toHaveBeenCalledExactlyOnceWith(true);
    } finally {
      presenter.destroy();
      driverPointerRules.remove();
    }
  });

  it('restarts for selectors controlled by a sibling ancestor branch', async () => {
    const driverPointerRules = installDriverPointerRules(`
      [data-mode="busy"] + section .nested-sibling-controlled,
      .nested-controller:has([data-mode="busy"]) + section .nested-sibling-controlled {
        pointer-events: none !important;
      }
    `);
    const container = document.createElement('div');
    const controller = document.createElement('div');
    const marker = document.createElement('span');
    const targetContainer = document.createElement('section');
    const target = document.createElement('button');
    target.className = 'nested-sibling-controlled';
    target.dataset.mpgdTutorialTarget = 'duplicate';
    setRect(target, { height: 40, left: 20, top: 20, width: 100 });
    controller.className = 'nested-controller';
    controller.appendChild(marker);
    targetContainer.appendChild(target);
    container.append(controller, targetContainer);
    document.body.appendChild(container);
    const presenter = createDriverTutorialPresenter({
      onAcknowledge: vi.fn(),
      onSkip: vi.fn(),
    });

    try {
      presenter.present({
        acknowledgeOnTargetClick: true,
        copy,
        step: tutorial.steps[0],
      });
      await nextFrame();
      const initialPopover = document.querySelector('[data-mpgd-tutorial-popover]');

      controller.dataset.mode = 'busy';
      await nextFrame();
      const directSiblingPopover = document.querySelector('[data-mpgd-tutorial-popover]');
      expect(directSiblingPopover).not.toBe(initialPopover);
      expect(target.classList.contains('driver-no-interaction')).toBe(true);

      delete controller.dataset.mode;
      await nextFrame();
      const restoredPopover = document.querySelector('[data-mpgd-tutorial-popover]');
      expect(restoredPopover).not.toBe(directSiblingPopover);
      expect(target.classList.contains('driver-no-interaction')).toBe(false);

      marker.dataset.mode = 'busy';
      await nextFrame();
      expect(document.querySelector('[data-mpgd-tutorial-popover]')).not.toBe(restoredPopover);
      expect(target.classList.contains('driver-no-interaction')).toBe(true);
    } finally {
      presenter.destroy();
      driverPointerRules.remove();
    }
  });

  it('restarts a scoped target when a global stylesheet changes its pointer state', async () => {
    const driverPointerRules = installDriverPointerRules();
    const hostStyle = document.createElement('style');
    const root = document.createElement('section');
    const target = document.createElement('button');
    target.className = 'stylesheet-controlled';
    target.dataset.mpgdTutorialTarget = 'duplicate';
    setRect(target, { height: 40, left: 20, top: 20, width: 100 });
    root.appendChild(target);
    document.head.appendChild(hostStyle);
    document.body.appendChild(root);
    const onActiveChange = vi.fn();
    const presenter = createDriverTutorialPresenter({
      onAcknowledge: vi.fn(),
      onActiveChange,
      onSkip: vi.fn(),
      root,
    });

    try {
      presenter.present({
        acknowledgeOnTargetClick: true,
        copy,
        step: tutorial.steps[0],
      });
      await nextFrame();
      const interactivePopover = document.querySelector('[data-mpgd-tutorial-popover]');

      hostStyle.textContent = '.stylesheet-controlled { pointer-events: none; }';
      await nextFrame();
      const blockedPopover = document.querySelector('[data-mpgd-tutorial-popover]');
      expect(blockedPopover).not.toBe(interactivePopover);
      expect(target.classList.contains('driver-no-interaction')).toBe(true);
      expect(document.querySelector<HTMLElement>('[data-mpgd-tutorial-next]')?.style.display)
        .toBe('block');

      hostStyle.textContent = '';
      await nextFrame();
      expect(document.querySelector('[data-mpgd-tutorial-popover]')).not.toBe(blockedPopover);
      expect(target.classList.contains('driver-no-interaction')).toBe(false);
      expect(onActiveChange).toHaveBeenCalledExactlyOnceWith(true);
    } finally {
      presenter.destroy();
      hostStyle.remove();
      driverPointerRules.remove();
    }
  });

  it('restarts for relevant style and stylesheet link attribute changes', async () => {
    const driverPointerRules = installDriverPointerRules();
    const hostStyle = document.createElement('style');
    const stylesheetLink = document.createElement('link');
    stylesheetLink.rel = 'stylesheet';
    const target = document.createElement('button');
    target.dataset.mpgdTutorialTarget = 'duplicate';
    setRect(target, { height: 40, left: 20, top: 20, width: 100 });
    document.head.append(hostStyle, stylesheetLink);
    document.body.appendChild(target);
    const onActiveChange = vi.fn();
    const presenter = createDriverTutorialPresenter({
      onAcknowledge: vi.fn(),
      onActiveChange,
      onSkip: vi.fn(),
    });

    try {
      presenter.present({
        acknowledgeOnTargetClick: true,
        copy,
        step: tutorial.steps[0],
      });
      await nextFrame();
      const initialPopover = document.querySelector('[data-mpgd-tutorial-popover]');

      hostStyle.setAttribute('media', 'screen');
      await nextFrame();
      const stylePopover = document.querySelector('[data-mpgd-tutorial-popover]');
      expect(stylePopover).not.toBe(initialPopover);

      stylesheetLink.setAttribute('media', 'print');
      await nextFrame();
      expect(document.querySelector('[data-mpgd-tutorial-popover]')).not.toBe(stylePopover);
      expect(target.classList.contains('driver-active-element')).toBe(true);
      expect(onActiveChange).toHaveBeenCalledExactlyOnceWith(true);
    } finally {
      presenter.destroy();
      hostStyle.remove();
      stylesheetLink.remove();
      driverPointerRules.remove();
    }
  });

  it('re-evaluates target click acknowledgement across pointer state changes', async () => {
    const driverPointerRules = installDriverPointerRules(`
      .test-pointer-disabled { pointer-events: none; }
    `);
    const target = document.createElement('button');
    target.dataset.mpgdTutorialTarget = 'duplicate';
    setRect(target, { height: 40, left: 20, top: 20, width: 100 });
    document.body.appendChild(target);
    const onAcknowledge = vi.fn();
    const onActiveChange = vi.fn();
    const presenter = createDriverTutorialPresenter({
      onAcknowledge,
      onActiveChange,
      onSkip: vi.fn(),
    });

    try {
      presenter.present({
        acknowledgeOnTargetClick: true,
        copy,
        step: tutorial.steps[0],
      });
      await nextFrame();

      expect(document.querySelector<HTMLElement>('[data-mpgd-tutorial-next]')?.style.display)
        .not.toBe('block');
      const initialPopover = document.querySelector('[data-mpgd-tutorial-popover]');
      await clickAndFlush(target);
      expect(onAcknowledge).toHaveBeenCalledTimes(1);

      target.classList.add('test-pointer-disabled');
      await nextFrame();
      const blockedPopover = document.querySelector('[data-mpgd-tutorial-popover]');
      expect(blockedPopover).not.toBe(initialPopover);
      expect(target.classList.contains('driver-no-interaction')).toBe(true);
      expect(document.querySelector<HTMLElement>('[data-mpgd-tutorial-next]')?.style.display)
        .toBe('block');
      target.click();
      expect(onAcknowledge).toHaveBeenCalledTimes(1);

      target.classList.remove('test-pointer-disabled');
      await nextFrame();
      expect(document.querySelector('[data-mpgd-tutorial-popover]')).not.toBe(blockedPopover);
      expect(target.classList.contains('driver-no-interaction')).toBe(false);
      expect(document.querySelector<HTMLElement>('[data-mpgd-tutorial-next]')?.style.display)
        .not.toBe('block');
      await clickAndFlush(target);
      expect(onAcknowledge).toHaveBeenCalledTimes(2);
      expect(onActiveChange).toHaveBeenCalledExactlyOnceWith(true);
    } finally {
      presenter.destroy();
      driverPointerRules.remove();
    }
  });

  it('prefers a clickable duplicate over a target with pointer events disabled', async () => {
    const driverPointerRules = installDriverPointerRules(`
      .test-pointer-disabled { pointer-events: none; }
    `);
    const blockedTarget = document.createElement('button');
    blockedTarget.className = 'test-pointer-disabled';
    blockedTarget.dataset.mpgdTutorialTarget = 'duplicate';
    setRect(blockedTarget, { height: 40, left: 20, top: 20, width: 100 });
    const clickableTarget = document.createElement('button');
    clickableTarget.dataset.mpgdTutorialTarget = 'duplicate';
    setRect(clickableTarget, { height: 40, left: 140, top: 20, width: 100 });
    document.body.append(blockedTarget, clickableTarget);
    const onAcknowledge = vi.fn();
    const presenter = createDriverTutorialPresenter({
      onAcknowledge,
      onSkip: vi.fn(),
    });

    try {
      presenter.present({
        acknowledgeOnTargetClick: true,
        copy,
        step: tutorial.steps[0],
      });
      await nextFrame();

      expect(blockedTarget.classList.contains('driver-active-element')).toBe(false);
      expect(clickableTarget.classList.contains('driver-active-element')).toBe(true);
      blockedTarget.click();
      expect(onAcknowledge).not.toHaveBeenCalled();
      await clickAndFlush(clickableTarget);
      expect(onAcknowledge).toHaveBeenCalledExactlyOnceWith('blocked');
    } finally {
      presenter.destroy();
      driverPointerRules.remove();
    }
  });

  it('prefers an enabled duplicate for an action-gated target step', async () => {
    const disabledTarget = document.createElement('button');
    disabledTarget.disabled = true;
    disabledTarget.dataset.mpgdTutorialTarget = 'choice';
    setRect(disabledTarget, { height: 40, left: 20, top: 20, width: 100 });
    const enabledTarget = document.createElement('button');
    enabledTarget.dataset.mpgdTutorialTarget = 'choice';
    setRect(enabledTarget, { height: 40, left: 140, top: 20, width: 100 });
    document.body.append(disabledTarget, enabledTarget);
    const presenter = createDriverTutorialPresenter({
      onAcknowledge: vi.fn(),
      onSkip: vi.fn(),
    });

    try {
      presenter.present({ copy, step: tutorial.steps[1] });
      await nextFrame();

      expect(disabledTarget.classList.contains('driver-active-element')).toBe(false);
      expect(enabledTarget.classList.contains('driver-active-element')).toBe(true);
      expect(document.querySelector<HTMLElement>('.driver-popover-footer')?.style.display)
        .toBe('none');
      expect(document.querySelector('[data-mpgd-tutorial-skip]')).not.toBeNull();
    } finally {
      presenter.destroy();
    }
  });

  it('keeps a disabled-only action target guided until the host enables it', async () => {
    const target = document.createElement('button');
    target.disabled = true;
    target.dataset.mpgdTutorialTarget = 'choice';
    setRect(target, { height: 40, left: 20, top: 20, width: 100 });
    const hostAction = vi.fn();
    target.addEventListener('click', hostAction);
    document.body.appendChild(target);
    const presenter = createDriverTutorialPresenter({
      onAcknowledge: vi.fn(),
      onSkip: vi.fn(),
    });

    try {
      presenter.present({ copy, step: tutorial.steps[1] });
      await nextFrame();

      expect(target.classList.contains('driver-active-element')).toBe(true);
      expect(document.querySelector<HTMLElement>('.driver-popover-footer')?.style.display)
        .toBe('none');
      expect(document.querySelector('[data-mpgd-tutorial-skip]')).not.toBeNull();
      await clickAndFlush(target);
      expect(hostAction).not.toHaveBeenCalled();

      target.disabled = false;
      await nextFrame();
      expect(target.classList.contains('driver-active-element')).toBe(true);
      target.click();
      expect(hostAction).toHaveBeenCalledOnce();
    } finally {
      presenter.destroy();
    }
  });

  it('updates target-click acknowledgement when the same target becomes disabled and enabled', async () => {
    const target = document.createElement('button');
    target.dataset.mpgdTutorialTarget = 'duplicate';
    setRect(target, { height: 40, left: 20, top: 20, width: 100 });
    document.body.appendChild(target);
    const onAcknowledge = vi.fn();
    const presenter = createDriverTutorialPresenter({
      onAcknowledge,
      onSkip: vi.fn(),
    });

    try {
      presenter.present({
        acknowledgeOnTargetClick: true,
        copy,
        step: tutorial.steps[0],
      });
      await nextFrame();
      expect(document.activeElement).toBe(
        document.querySelector('[data-mpgd-tutorial-skip]'),
      );

      target.disabled = true;
      await nextFrame();
      expect(document.querySelector<HTMLElement>('[data-mpgd-tutorial-next]')?.style.display)
        .toBe('block');
      expect(target.classList.contains('driver-active-element')).toBe(true);
      expect(target.classList.contains('driver-no-interaction')).toBe(true);
      expect(target.getAttribute('aria-controls')).toBe('driver-popover-content');
      expect(target.getAttribute('aria-expanded')).toBe('true');
      expect(target.getAttribute('aria-haspopup')).toBe('dialog');
      target.click();
      expect(onAcknowledge).not.toHaveBeenCalled();

      target.disabled = false;
      await nextFrame();
      expect(target.classList.contains('driver-active-element')).toBe(true);
      expect(target.classList.contains('driver-no-interaction')).toBe(false);
      expect(target.getAttribute('aria-controls')).toBe('driver-popover-content');
      expect(target.getAttribute('aria-expanded')).toBe('true');
      expect(target.getAttribute('aria-haspopup')).toBe('dialog');
      await clickAndFlush(target);
      expect(onAcknowledge).toHaveBeenCalledExactlyOnceWith('blocked');
    } finally {
      presenter.destroy();
    }
  });

  it('keeps Next available beneath a composed aria-disabled ancestor', async () => {
    const host = document.createElement('div');
    host.setAttribute('aria-disabled', 'true');
    const shadowRoot = host.attachShadow({ mode: 'open' });
    const target = document.createElement('button');
    target.dataset.mpgdTutorialTarget = 'duplicate';
    setRect(target, { height: 40, left: 20, top: 20, width: 100 });
    shadowRoot.appendChild(target);
    document.body.appendChild(host);
    const onAcknowledge = vi.fn();
    const presenter = createDriverTutorialPresenter({
      onAcknowledge,
      onSkip: vi.fn(),
      resolveTarget: () => target,
    });

    try {
      presenter.present({
        acknowledgeOnTargetClick: true,
        copy,
        step: tutorial.steps[0],
      });
      await nextFrame();

      const next = document.querySelector<HTMLButtonElement>('[data-mpgd-tutorial-next]');
      expect(next?.style.display).toBe('block');
      target.click();
      expect(onAcknowledge).not.toHaveBeenCalled();
      next?.click();
      expect(onAcknowledge).toHaveBeenCalledExactlyOnceWith('blocked');
    } finally {
      presenter.destroy();
    }
  });

  it('contains throwing active-state and acknowledge callbacks', async () => {
    const target = document.createElement('button');
    target.dataset.mpgdTutorialTarget = 'duplicate';
    setRect(target, { height: 40, left: 20, top: 20, width: 100 });
    document.body.appendChild(target);
    const activeError = new Error('active callback failed');
    const acknowledgeError = new Error('acknowledge callback failed');
    const reporterError = new Error('reporting failed');
    const onError = vi.fn(() => {
      throw reporterError;
    });
    const presenter = createDriverTutorialPresenter({
      onAcknowledge: () => {
        throw acknowledgeError;
      },
      onActiveChange: () => {
        throw activeError;
      },
      onError,
      onSkip: vi.fn(),
    });

    try {
      presenter.present({ copy, step: tutorial.steps[0] });
      await nextFrame();
      expect(target.classList.contains('driver-active-element')).toBe(true);
      expect(onError).toHaveBeenCalledWith(activeError);

      document.querySelector<HTMLButtonElement>('[data-mpgd-tutorial-next]')?.click();
      expect(onError).toHaveBeenCalledWith(acknowledgeError);
    } finally {
      presenter.destroy();
    }
    expect(onError).toHaveBeenCalledTimes(3);
  });

  it('does not clear a replacement presenter state when an old presenter is destroyed twice', async () => {
    const target = document.createElement('button');
    target.dataset.mpgdTutorialTarget = 'duplicate';
    setRect(target, { height: 40, left: 20, top: 20, width: 100 });
    document.body.appendChild(target);
    const oldPresenter = createDriverTutorialPresenter({
      onAcknowledge: vi.fn(),
      onSkip: vi.fn(),
    });
    let oldPresenterDestroyed = false;
    let replacement: ReturnType<typeof createDriverTutorialPresenter> | undefined;
    try {
      oldPresenter.present({ copy, step: tutorial.steps[0] });
      await nextFrame();
      oldPresenter.destroy();
      oldPresenterDestroyed = true;
      replacement = createDriverTutorialPresenter({
        onAcknowledge: vi.fn(),
        onSkip: vi.fn(),
      });
      replacement.present({ copy, step: tutorial.steps[0] });
      await nextFrame();

      oldPresenter.destroy();
      oldPresenter.present({ copy, step: tutorial.steps[0] });

      expect(document.body.dataset.mpgdTutorialActive).toBe('true');
      expect(document.body.dataset.mpgdTutorialStep).toBe('blocked');
      expect(target.classList.contains('driver-active-element')).toBe(true);
      expect(document.querySelector('[data-mpgd-tutorial-popover]')).not.toBeNull();
    } finally {
      replacement?.destroy();
      if (!oldPresenterDestroyed) {
        oldPresenter.destroy();
      }
    }
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

  it('contains throwing replay error reporters and allows a retry', async () => {
    const button = document.createElement('button');
    const replayError = new Error('replay failed');
    let replayShouldFail = true;
    const replay = vi.fn(async () => {
      if (replayShouldFail) {
        throw replayError;
      }
    });
    const onError = vi.fn(() => {
      throw new Error('reporting failed');
    });
    const unhandledRejections: unknown[] = [];
    const recordUnhandledRejection = (reason: unknown): void => {
      unhandledRejections.push(reason);
    };
    process.on('unhandledRejection', recordUnhandledRejection);
    const unbind = bindTutorialReplayTrigger({
      director: { replay } as never,
      element: button,
      onError,
      presenter: {
        resetForReplay: vi.fn(),
        waitForPendingSkip: vi.fn(async () => undefined),
      },
    });

    try {
      button.click();
      await vi.waitFor(() => expect(onError).toHaveBeenCalledExactlyOnceWith(replayError));
      await new Promise((resolve) => setTimeout(resolve, 0));

      replayShouldFail = false;
      button.click();
      await vi.waitFor(() => expect(replay).toHaveBeenCalledTimes(2));
      expect(unhandledRejections).toEqual([]);
    } finally {
      unbind();
      process.off('unhandledRejection', recordUnhandledRejection);
    }
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

async function clickAndFlush(element: HTMLElement): Promise<void> {
  element.click();
  await Promise.resolve();
}

function installDriverPointerRules(additionalRules = ''): HTMLStyleElement {
  const style = document.createElement('style');
  style.textContent = `
    ${additionalRules}
    .driver-active * { pointer-events: none; }
    .driver-active .driver-active-element,
    .driver-active .driver-active-element *,
    .driver-popover,
    .driver-popover * { pointer-events: auto; }
    .driver-no-interaction,
    .driver-no-interaction * { pointer-events: none !important; }
  `;
  document.head.appendChild(style);
  return style;
}
