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

    presenter.destroy();
    expect(modal.getAttribute('aria-modal')).toBe('true');
    expect(modal.hasAttribute('aria-owns')).toBe(false);
  });

  it('does not overwrite host ARIA updates made during a guided step', async () => {
    const modal = document.createElement('section');
    modal.setAttribute('aria-modal', 'true');
    modal.setAttribute('role', 'dialog');
    setRect(modal, { height: 300, left: 20, top: 20, width: 300 });
    const choice = document.createElement('button');
    choice.dataset.mpgdTutorialTarget = 'choice';
    choice.setAttribute('aria-expanded', 'false');
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
    choice.setAttribute('aria-expanded', 'host-updated');
    choice.setAttribute('aria-controls', 'host-panel');
    presenter.destroy();

    expect(modal.getAttribute('aria-modal')).toBe('host-closed');
    expect(modal.getAttribute('aria-owns')).toBe('host-owned');
    expect(choice.getAttribute('aria-expanded')).toBe('host-updated');
    expect(choice.getAttribute('aria-controls')).toBe('host-panel');
  });

  it('binds replay only when a host provides a trigger', async () => {
    const button = document.createElement('button');
    const replay = vi.fn(async () => undefined);
    const unbind = bindTutorialReplayTrigger({
      director: { replay } as never,
      element: button,
    });
    button.click();
    await vi.waitFor(() => expect(replay).toHaveBeenCalledOnce());
    unbind();
    button.click();
    expect(replay).toHaveBeenCalledOnce();
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

async function nextFrame(): Promise<void> {
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
}
