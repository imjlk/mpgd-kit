import { driver, type Driver, type DriveStep } from 'driver.js';

import type { TutorialDefinition, TutorialStep } from './definition.js';
import type { TutorialDirector } from './director.js';
import { tutorialDomAttributes } from './index.js';

export interface DriverTutorialCopy {
  readonly description: string;
  readonly done: string;
  readonly next: string;
  readonly skip: string;
  readonly title: string;
}

export interface DriverTutorialPresentation<TStep extends TutorialStep = TutorialStep> {
  readonly acknowledgeOnTargetClick?: boolean;
  readonly allowTargetInteraction?: boolean;
  readonly copy: DriverTutorialCopy;
  readonly finalStep?: boolean;
  readonly step: TStep;
}

export interface DriverTutorialPresenterInput<TStep extends TutorialStep = TutorialStep> {
  readonly missingTarget?: 'error' | 'unanchored' | 'wait';
  readonly modalSelector?: string;
  readonly onAcknowledge: (stepId: TStep['id']) => void;
  readonly onActiveChange?: (active: boolean) => void;
  readonly onError?: (error: unknown) => void;
  readonly onSkip: () => Promise<void> | void;
  readonly resolveTarget?: (
    target: TStep['target'],
    root: Document | HTMLElement,
  ) => HTMLElement | null;
  readonly root?: Document | HTMLElement;
  readonly stateHost?: HTMLElement;
  readonly targetAttribute?: string;
}

export interface DriverTutorialPresenter<TStep extends TutorialStep = TutorialStep> {
  destroy(): void;
  present(presentation: DriverTutorialPresentation<TStep> | null): void;
  refresh(): void;
}

interface TutorialTargetSemanticsGuard {
  applyDriverMutation<T>(mutation: () => T): T;
  restore(driverAlreadyDestroyed?: boolean): void;
}

interface TutorialModalSemanticsGuard {
  readonly modal: HTMLElement | null;
  readonly popover: HTMLElement;
  restore(): void;
}

export function createDriverTutorialPresenter<TStep extends TutorialStep>(
  input: DriverTutorialPresenterInput<TStep>,
): DriverTutorialPresenter<TStep> {
  const root = input.root ?? document;
  const ownerDocumentCandidate = root.nodeType === 9 ? root as Document : root.ownerDocument;

  if (ownerDocumentCandidate === null) {
    throw new Error('Driver tutorial presenter requires an attached owner document.');
  }

  const ownerDocument = ownerDocumentCandidate;

  if (typeof document === 'undefined' || ownerDocument !== document) {
    throw new Error('Driver tutorial presenter supports only the current browser document.');
  }

  const browserWindowCandidate = ownerDocument.defaultView;

  if (browserWindowCandidate === null) {
    throw new Error('Driver tutorial presenter requires a browser document.');
  }

  const browserWindow = browserWindowCandidate;

  const stateHost = input.stateHost ?? ownerDocument.body;
  const targetAttribute = input.targetAttribute ?? tutorialDomAttributes.target;
  const escapedCopy = (value: string): string => escapeTutorialText(ownerDocument, value);
  let activePresentation: DriverTutorialPresentation<TStep> | null = null;
  let activePresentationKey: string | null = null;
  let instance: Driver | null = null;
  let frame: number | undefined;
  let destroyed = false;
  let reportedActive = false;
  let targetSemanticsGuard: TutorialTargetSemanticsGuard | undefined;
  let targetRestorePending = false;
  let dismissedPresentationKey: string | null = null;
  let skipPendingKey: string | null = null;
  let retryableDismissedKey: string | null = null;
  let missingTargetErrorKey: string | null = null;
  let syncModalSemantics: (() => void) | undefined;

  const reportActive = (active: boolean): void => {
    if (reportedActive === active) {
      return;
    }

    reportedActive = active;
    input.onActiveChange?.(active);
  };

  const scheduleRefresh = (): void => {
    if (destroyed || frame !== undefined || dismissedPresentationKey !== null) {
      return;
    }

    frame = browserWindow.requestAnimationFrame(() => {
      frame = undefined;

      if (destroyed || dismissedPresentationKey !== null) {
        return;
      }

      const currentInstance = instance;

      if (currentInstance === null || !currentInstance.isActive()) {
        driveActiveStep();
        return;
      }

      rebindActiveTarget(currentInstance, activePresentation);
    });
  };

  const createInstance = (presentation: DriverTutorialPresentation<TStep>): Driver => {
    let created!: Driver;
    let modalSemanticsGuard: TutorialModalSemanticsGuard | undefined;
    let popover: HTMLElement | null = null;
    const syncCreatedModalSemantics = (): void => {
      if (popover === null) {
        return;
      }

      const modalSelector = input.modalSelector ?? '[role="dialog"][aria-modal="true"]';
      const modal = resolveUnderlyingTutorialModal(
        popover,
        presentation.step.interaction,
        created.getActiveElement(),
        modalSelector,
        modalSemanticsGuard?.modal ?? null,
      );

      if (modalSemanticsGuard?.modal === modal && modalSemanticsGuard.popover === popover) {
        return;
      }

      modalSemanticsGuard?.restore();
      modalSemanticsGuard = configureTutorialModalSemantics(
        popover,
        presentation.step.interaction,
        modal,
      );
    };
    created = driver({
      allowClose: true,
      allowKeyboardControl: false,
      allowScroll: true,
      animate: false,
      disableActiveInteraction: true,
      doneBtnText: presentation.finalStep === true
        ? escapedCopy(presentation.copy.done)
        : escapedCopy(presentation.copy.next),
      nextBtnText: escapedCopy(presentation.copy.next),
      overlayClickBehavior: () => undefined,
      overlayColor: '#0e1214',
      overlayOpacity: 0.78,
      popoverClass: 'mpgd-tutorial-popover',
      popoverOffset: 12,
      prevBtnText: '',
      showButtons: ['next', 'close'],
      showProgress: false,
      skipMissingElement: false,
      smoothScroll: false,
      stagePadding: 7,
      stageRadius: 9,
      waitForElement: 900,
      onCloseClick: () => {
        const dismissedKey = activePresentationKey;
        dismissedPresentationKey = dismissedKey;
        skipPendingKey = dismissedKey;
        retryableDismissedKey = null;
        destroyInstancePreservingTarget(created);
        void Promise.resolve()
          .then(() => input.onSkip())
          .catch((error: unknown) => {
            if (dismissedPresentationKey === dismissedKey) {
              retryableDismissedKey = dismissedKey;
            }

            input.onError?.(error);
          })
          .finally(() => {
            if (skipPendingKey === dismissedKey) {
              skipPendingKey = null;
            }
          });
      },
      onDestroyed: () => {
        if (!targetRestorePending) {
          targetSemanticsGuard?.restore(true);
        }

        targetSemanticsGuard = undefined;
        targetRestorePending = false;
        modalSemanticsGuard?.restore();
        modalSemanticsGuard = undefined;

        if (syncModalSemantics === syncCreatedModalSemantics) {
          syncModalSemantics = undefined;
        }

        if (instance === created) {
          instance = null;
          clearTutorialState(stateHost);
          reportActive(false);
        }

        if (!destroyed && activePresentation !== null) {
          scheduleRefresh();
        }
      },
      onPopoverRender: ({ closeButton, nextButton, wrapper }) => {
        closeButton.setAttribute('aria-label', presentation.copy.skip);
        closeButton.title = presentation.copy.skip;
        closeButton.textContent = presentation.copy.skip;
        closeButton.setAttribute(tutorialDomAttributes.skip, 'true');
        nextButton.setAttribute(tutorialDomAttributes.next, 'true');
        wrapper.setAttribute(tutorialDomAttributes.popover, 'true');
        popover = wrapper;
        syncModalSemantics = syncCreatedModalSemantics;
        syncCreatedModalSemantics();
        if (presentation.step.advance.kind === 'acknowledge') {
          browserWindow.queueMicrotask(() => nextButton.focus());
        }
      },
    });
    return created;
  };

  const driveActiveStep = (): void => {
    const presentation = activePresentation;
    const presentationKey = activePresentationKey;

    if (presentation === null || presentationKey === null || instance?.isActive() === true) {
      return;
    }

    const target = resolvePresentationTarget(presentation, presentationKey);

    if (destroyed
      || activePresentation !== presentation
      || activePresentationKey !== presentationKey) {
      return;
    }

    if (presentation.step.target !== null && target === null) {
      const policy = input.missingTarget ?? 'wait';

      if (policy === 'error') {
        reportMissingTarget(presentation, presentationKey);
        return;
      }

      if (policy === 'wait') {
        return;
      }
    } else {
      missingTargetErrorKey = null;
    }

    const nextInstance = createInstance(presentation);
    instance = nextInstance;
    targetSemanticsGuard?.restore();
    targetSemanticsGuard = target === null
      ? undefined
      : preserveTutorialTargetSemantics(target, browserWindow);

    try {
      stateHost.setAttribute(tutorialDomAttributes.active, 'true');
      stateHost.setAttribute(tutorialDomAttributes.step, presentation.step.id);
      nextInstance.setSteps([
        createDriveStep(input, presentation, target ?? undefined, ownerDocument),
      ]);
      applyDriverTargetMutation(() => nextInstance.drive());
      syncModalSemantics?.();
      reportActive(true);
    } catch (error) {
      dismissedPresentationKey = activePresentationKey;

      try {
        destroyInstancePreservingTarget(nextInstance);
      } finally {
        targetSemanticsGuard = undefined;
        instance = null;
        syncModalSemantics = undefined;
        clearTutorialState(stateHost);
        reportActive(false);
      }

      input.onError?.(error);
    }
  };

  const resolvePresentationTarget = (
    presentation: DriverTutorialPresentation<TStep>,
    presentationKey: string | null = activePresentationKey,
  ): HTMLElement | null => {
    if (presentation.step.target === null) {
      return null;
    }

    try {
      return input.resolveTarget?.(presentation.step.target, root)
        ?? resolveVisibleTutorialTarget({
          root,
          target: presentation.step.target,
          targetAttribute,
          view: browserWindow,
        });
    } catch (error) {
      if (presentationKey !== null
        && presentationKey === activePresentationKey
        && missingTargetErrorKey !== presentationKey) {
        missingTargetErrorKey = presentationKey;
        input.onError?.(error);
      }

      return null;
    }
  };

  const observationRoot = root.nodeType === 9 ? ownerDocument.documentElement : root as HTMLElement;
  const mutationObserver = new browserWindow.MutationObserver((records) => {
    if (activePresentation === null && instance === null) {
      return;
    }

    if (records.some((record) => !isDriverOwnedMutation(record))) {
      scheduleRefresh();
    }
  });
  mutationObserver.observe(observationRoot, {
    attributes: true,
    childList: true,
    subtree: true,
  });
  const resizeObserver = typeof browserWindow.ResizeObserver === 'function'
    ? new browserWindow.ResizeObserver(scheduleRefresh)
    : null;
  resizeObserver?.observe(observationRoot);
  observationRoot.addEventListener('scroll', scheduleRefresh, true);
  browserWindow.visualViewport?.addEventListener('resize', scheduleRefresh);
  browserWindow.visualViewport?.addEventListener('scroll', scheduleRefresh);
  browserWindow.addEventListener('orientationchange', scheduleRefresh);

  return {
    destroy() {
      destroyed = true;
      activePresentation = null;
      activePresentationKey = null;
      dismissedPresentationKey = null;
      skipPendingKey = null;
      retryableDismissedKey = null;
      missingTargetErrorKey = null;
      mutationObserver.disconnect();
      resizeObserver?.disconnect();
      observationRoot.removeEventListener('scroll', scheduleRefresh, true);
      browserWindow.visualViewport?.removeEventListener('resize', scheduleRefresh);
      browserWindow.visualViewport?.removeEventListener('scroll', scheduleRefresh);
      browserWindow.removeEventListener('orientationchange', scheduleRefresh);

      if (frame !== undefined) {
        browserWindow.cancelAnimationFrame(frame);
      }

      if (instance !== null) {
        destroyInstancePreservingTarget(instance);
      }

      instance = null;
      targetSemanticsGuard = undefined;
      clearTutorialState(stateHost);
      reportActive(false);
    },
    present(presentation) {
      const nextKey = presentation === null
        ? null
        : JSON.stringify([
            presentation.step.id,
            presentation.copy.title,
            presentation.copy.description,
            presentation.copy.next,
            presentation.copy.done,
            presentation.copy.skip,
            presentation.acknowledgeOnTargetClick === true,
            presentation.allowTargetInteraction === true,
            presentation.finalStep === true,
          ]);

      if (dismissedPresentationKey !== null
        && (dismissedPresentationKey !== nextKey || retryableDismissedKey === nextKey)) {
        dismissedPresentationKey = null;
        retryableDismissedKey = null;
      }

      if (activePresentationKey !== nextKey) {
        missingTargetErrorKey = null;
      }

      if (activePresentationKey === nextKey) {
        activePresentation = presentation;
        scheduleRefresh();
        return;
      }

      activePresentation = presentation;
      activePresentationKey = nextKey;
      const previousInstance = instance;
      instance = null;

      if (previousInstance !== null) {
        destroyInstancePreservingTarget(previousInstance);
      }

      clearTutorialState(stateHost);
      reportActive(false);
      scheduleRefresh();
    },
    refresh: scheduleRefresh,
  };

  function rebindActiveTarget(
    currentInstance: Driver,
    presentation: DriverTutorialPresentation<TStep> | null,
  ): void {
    if (presentation === null || presentation.step.target === null || !currentInstance.isActive()) {
      applyDriverTargetMutation(() => currentInstance.refresh());
      syncModalSemantics?.();
      return;
    }

    const presentationKey = activePresentationKey;
    const target = resolvePresentationTarget(presentation, presentationKey);

    if (destroyed
      || activePresentation !== presentation
      || activePresentationKey !== presentationKey
      || instance !== currentInstance
      || !currentInstance.isActive()) {
      return;
    }

    if (target === null) {
      const policy = input.missingTarget ?? 'wait';

      if (policy === 'unanchored') {
        missingTargetErrorKey = null;

        if (currentInstance.getActiveElement()?.id === 'driver-dummy-element') {
          applyDriverTargetMutation(() => currentInstance.refresh());
          syncModalSemantics?.();
          return;
        }

        const current = currentInstance.getActiveStep();

        if (current === undefined) {
          applyDriverTargetMutation(() => currentInstance.refresh());
          syncModalSemantics?.();
          return;
        }

        rebindTarget(currentInstance, current, undefined);
        return;
      }

      destroyInstancePreservingTarget(currentInstance);

      if (policy === 'error') {
        reportMissingTarget(presentation, presentationKey);
      }

      return;
    }

    missingTargetErrorKey = null;

    if (currentInstance.getActiveElement() === target) {
      applyDriverTargetMutation(() => currentInstance.refresh());
      syncModalSemantics?.();
      return;
    }

    const current = currentInstance.getActiveStep();

    if (current === undefined) {
      applyDriverTargetMutation(() => currentInstance.refresh());
      syncModalSemantics?.();
      return;
    }

    rebindTarget(currentInstance, current, target);
  }

  function rebindTarget(
    currentInstance: Driver,
    current: DriveStep,
    target: HTMLElement | undefined,
  ): void {
    const previousTarget = currentInstance.getActiveElement();
    const { element: _previousElement, ...currentWithoutElement } = current;
    targetSemanticsGuard?.restore();
    const restorePreviousTarget = !(previousTarget instanceof HTMLElement)
      ? undefined
      : captureTutorialTargetSemantics(previousTarget, target?.parentElement ?? null);
    targetSemanticsGuard = target === undefined
      ? undefined
      : preserveTutorialTargetSemantics(target, browserWindow);
    applyDriverTargetMutation(() => currentInstance.highlight(
      target === undefined
        ? currentWithoutElement
        : { ...currentWithoutElement, element: target },
    ));
    restorePreviousTarget?.();
    syncModalSemantics?.();
  }

  function reportMissingTarget(
    presentation: DriverTutorialPresentation<TStep>,
    presentationKey: string | null = activePresentationKey,
  ): void {
    if (presentationKey === null
      || presentationKey !== activePresentationKey
      || missingTargetErrorKey === presentationKey) {
      return;
    }

    missingTargetErrorKey = presentationKey;
    input.onError?.(
      new Error(`Tutorial target was not found: ${String(presentation.step.target)}`),
    );
  }

  function destroyInstancePreservingTarget(currentInstance: Driver): void {
    const target = currentInstance.getActiveElement();
    targetSemanticsGuard?.restore();
    const restoreAfterDestroy = !(target instanceof HTMLElement)
      ? undefined
      : captureTutorialTargetSemantics(target);
    targetRestorePending = true;
    currentInstance.destroy();
    targetRestorePending = false;
    restoreAfterDestroy?.();
    targetSemanticsGuard = undefined;
  }

  function applyDriverTargetMutation<T>(mutation: () => T): T {
    return targetSemanticsGuard === undefined
      ? mutation()
      : targetSemanticsGuard.applyDriverMutation(mutation);
  }
}

export function resolveVisibleTutorialTarget(input: {
  readonly root?: Document | HTMLElement;
  readonly target: string;
  readonly targetAttribute?: string;
  readonly view?: Window;
}): HTMLElement | null {
  const root = input.root ?? document;
  const ownerDocument = root.nodeType === 9 ? root as Document : root.ownerDocument;

  if (ownerDocument === null) {
    return null;
  }

  const view = input.view ?? ownerDocument.defaultView;

  if (view === null) {
    return null;
  }

  const attribute = input.targetAttribute ?? tutorialDomAttributes.target;
  const selector = `[${attribute}="${escapeAttributeValue(input.target)}"]`;
  const candidates = [...root.querySelectorAll<HTMLElement>(selector)];

  return candidates.find((element) => isVisibleTutorialTarget(element, view))
    ?? candidates.find((element) => isRenderableTutorialTarget(element, view))
    ?? null;
}

export function isVisibleTutorialTarget(element: HTMLElement, view: Window = window): boolean {
  if (!isRenderableTutorialTarget(element, view)) {
    return false;
  }

  let visible = intersectRect(element.getBoundingClientRect(), {
    bottom: view.innerHeight,
    left: 0,
    right: view.innerWidth,
    top: 0,
  });
  let ancestor = element.parentElement;

  while (visible !== null && ancestor !== null) {
    const style = view.getComputedStyle(ancestor);

    if (style.display === 'none'
      || style.visibility === 'hidden'
      || Number.parseFloat(style.opacity || '1') <= 0) {
      return false;
    }

    if ([style.overflow, style.overflowX, style.overflowY].some(
      (value) => value === 'auto' || value === 'clip' || value === 'hidden' || value === 'scroll',
    )) {
      visible = intersectRect(visible, ancestor.getBoundingClientRect());
    }

    ancestor = ancestor.parentElement;
  }

  return visible !== null && visible.right > visible.left && visible.bottom > visible.top;
}

export function bindTutorialReplayTrigger<TDefinition extends TutorialDefinition>(input: {
  readonly beforeReplay?: () => Promise<void> | void;
  readonly director: TutorialDirector<TDefinition>;
  readonly element: HTMLElement;
  readonly onError?: (error: unknown) => void;
}): () => void {
  let pending = false;
  const listener = (): void => {
    if (pending) {
      return;
    }

    pending = true;
    void Promise.resolve()
      .then(() => input.beforeReplay?.())
      .then(() => input.director.replay())
      .catch((error: unknown) => input.onError?.(error))
      .finally(() => {
        pending = false;
      });
  };
  input.element.addEventListener('click', listener);
  return () => input.element.removeEventListener('click', listener);
}

function createDriveStep<TStep extends TutorialStep>(
  input: DriverTutorialPresenterInput<TStep>,
  presentation: DriverTutorialPresentation<TStep>,
  target: DriveStep['element'],
  ownerDocument: Document,
): DriveStep {
  const { step } = presentation;
  const actionGated = step.advance.kind === 'action' || step.advance.kind === 'signal';
  const acknowledgeOnTargetClick = presentation.acknowledgeOnTargetClick === true
    && step.advance.kind === 'acknowledge'
    && step.target !== null;
  const targetInteraction = presentation.allowTargetInteraction === true
    || acknowledgeOnTargetClick
    || step.interaction === 'target'
    || step.interaction === 'gameplay';

  return {
    ...(target === undefined ? {} : { element: target }),
    advanceOnClick: acknowledgeOnTargetClick,
    disableActiveInteraction: !targetInteraction,
    popover: {
      ...(step.side === undefined ? {} : { side: step.side }),
      ...(step.align === undefined ? {} : { align: step.align }),
      description: escapeTutorialText(ownerDocument, presentation.copy.description),
      doneBtnText: presentation.finalStep === true
        ? escapeTutorialText(ownerDocument, presentation.copy.done)
        : escapeTutorialText(ownerDocument, presentation.copy.next),
      nextBtnText: presentation.finalStep === true
        ? escapeTutorialText(ownerDocument, presentation.copy.done)
        : escapeTutorialText(ownerDocument, presentation.copy.next),
      showButtons: actionGated || acknowledgeOnTargetClick
        ? ['close']
        : ['next', 'close'],
      title: escapeTutorialText(ownerDocument, presentation.copy.title),
      onNextClick: () => input.onAcknowledge(step.id),
    },
  };
}

function resolveUnderlyingTutorialModal(
  popover: HTMLElement,
  interaction: TutorialStep['interaction'],
  activeElement: Element | undefined,
  modalSelector: string,
  currentModal: HTMLElement | null,
): HTMLElement | null {
  const activeModal = activeElement?.closest<HTMLElement>(modalSelector) ?? null;

  if (interaction !== 'blocked') {
    return activeModal;
  }

  if (activeElement !== undefined
    && currentModal?.isConnected === true
    && currentModal.contains(activeElement)) {
    return currentModal;
  }

  return activeModal
    ?? [...popover.ownerDocument.querySelectorAll<HTMLElement>(modalSelector)]
      .find((candidate) => candidate !== popover && !popover.contains(candidate))
    ?? (currentModal?.isConnected === true ? currentModal : null)
    ?? null;
}

function configureTutorialModalSemantics(
  popover: HTMLElement,
  interaction: TutorialStep['interaction'],
  underlyingModal: HTMLElement | null,
): TutorialModalSemanticsGuard {
  const ownedAttributes = new Map<'aria-modal' | 'aria-owns', string>();

  if (interaction === 'blocked') {
    popover.setAttribute('role', 'dialog');
    popover.setAttribute('aria-modal', 'true');

    if (underlyingModal !== null) {
      ownedAttributes.set('aria-modal', 'false');
    }
  } else {
    popover.setAttribute('role', 'region');
    popover.removeAttribute('aria-modal');

    if (underlyingModal !== null && popover.id !== '') {
      const ownedIds = new Set(
        (underlyingModal.getAttribute('aria-owns') ?? '').split(/\s+/u).filter(Boolean),
      );
      ownedIds.add(popover.id);
      ownedAttributes.set('aria-owns', [...ownedIds].join(' '));
    }
  }

  const restore = underlyingModal === null
    ? () => undefined
    : preserveTutorialModalSemantics(underlyingModal, ownedAttributes, popover.ownerDocument);

  return { modal: underlyingModal, popover, restore };
}

function preserveTutorialModalSemantics(
  element: HTMLElement,
  ownedAttributes: ReadonlyMap<'aria-modal' | 'aria-owns', string>,
  ownerDocument: Document,
): () => void {
  const view = ownerDocument.defaultView;

  if (view === null || ownedAttributes.size === 0) {
    return () => undefined;
  }

  type Attribute = 'aria-modal' | 'aria-owns';
  const previous = new Map<Attribute, string | null>();
  const hostValues = new Map<Attribute, string | null>();
  const captureHostMutations = (records: readonly MutationRecord[]): void => {
    for (const record of records) {
      const attribute = record.attributeName;

      if (record.target === element && isTutorialModalAttribute(attribute)) {
        hostValues.set(attribute, element.getAttribute(attribute));
      }
    }
  };

  for (const [attribute, value] of ownedAttributes) {
    const current = element.getAttribute(attribute);

    if (current === value) {
      continue;
    }

    previous.set(attribute, current);
    element.setAttribute(attribute, value);
  }

  if (previous.size === 0) {
    return () => undefined;
  }

  const observer = new view.MutationObserver(captureHostMutations);
  observer.observe(element, {
    attributeFilter: [...previous.keys()],
    attributes: true,
  });

  return () => {
    captureHostMutations(observer.takeRecords());
    observer.disconnect();

    for (const [attribute, previousValue] of previous) {
      if (hostValues.has(attribute)) {
        restoreAttribute(element, attribute, hostValues.get(attribute) ?? null);
        continue;
      }

      restoreOwnedAttribute(
        element,
        attribute,
        ownedAttributes.get(attribute) ?? null,
        previousValue,
      );
    }
  };
}

function isTutorialModalAttribute(
  attribute: string | null,
): attribute is 'aria-modal' | 'aria-owns' {
  return attribute === 'aria-modal' || attribute === 'aria-owns';
}

function preserveTutorialTargetSemantics(
  element: HTMLElement,
  view: Window & typeof globalThis,
): TutorialTargetSemanticsGuard {
  const attributes = ['aria-controls', 'aria-expanded', 'aria-haspopup'] as const;
  type Attribute = (typeof attributes)[number];
  const previous = Object.fromEntries(
    attributes.map((attribute) => [attribute, element.getAttribute(attribute)]),
  ) as Record<Attribute, string | null>;
  const driverOwned = {
    'aria-controls': 'driver-popover-content',
    'aria-expanded': 'true',
    'aria-haspopup': 'dialog',
  } as const;
  const hostValues = new Map<Attribute, string | null>();
  const decoratedParent = element.parentElement;
  let active = true;
  const captureHostMutations = (records: readonly MutationRecord[]): void => {
    for (const record of records) {
      const attribute = record.attributeName;

      if (record.target === element && isTutorialTargetAttribute(attribute)) {
        hostValues.set(attribute, element.getAttribute(attribute));
      }
    }
  };
  const observer = new view.MutationObserver(captureHostMutations);
  observer.observe(element, {
    attributeFilter: [...attributes],
    attributes: true,
  });

  return {
    applyDriverMutation<T>(mutation: () => T): T {
      captureHostMutations(observer.takeRecords());

      try {
        return mutation();
      } finally {
        observer.takeRecords();
      }
    },
    restore(driverAlreadyDestroyed = false) {
      if (!active) {
        return;
      }

      if (driverAlreadyDestroyed) {
        observer.takeRecords();
      } else {
        captureHostMutations(observer.takeRecords());
      }

      observer.disconnect();
      active = false;

      for (const attribute of attributes) {
        if (hostValues.has(attribute)) {
          restoreAttribute(element, attribute, hostValues.get(attribute) ?? null);
          continue;
        }

        const current = element.getAttribute(attribute);

        if (current === driverOwned[attribute] || (driverAlreadyDestroyed && current === null)) {
          restoreAttribute(element, attribute, previous[attribute]);
        }
      }

      clearDetachedDriverTargetClasses(element, decoratedParent);
    },
  };
}

function isTutorialTargetAttribute(
  attribute: string | null,
): attribute is 'aria-controls' | 'aria-expanded' | 'aria-haspopup' {
  return attribute === 'aria-controls'
    || attribute === 'aria-expanded'
    || attribute === 'aria-haspopup';
}

function captureTutorialTargetSemantics(
  element: HTMLElement,
  preservedParent: HTMLElement | null = null,
): () => void {
  const attributes = ['aria-controls', 'aria-expanded', 'aria-haspopup'] as const;
  const decoratedParent = element.parentElement;
  const captured = Object.fromEntries(
    attributes.map((attribute) => [attribute, element.getAttribute(attribute)]),
  ) as Record<(typeof attributes)[number], string | null>;

  return () => {
    for (const attribute of attributes) {
      restoreAttribute(element, attribute, captured[attribute]);
    }

    clearDetachedDriverTargetClasses(element, decoratedParent, preservedParent);
  };
}

function clearDetachedDriverTargetClasses(
  element: HTMLElement,
  decoratedParent: HTMLElement | null,
  preservedParent: HTMLElement | null = null,
): void {
  element.classList.remove('driver-active-element', 'driver-no-interaction');

  if (decoratedParent !== preservedParent) {
    decoratedParent?.classList.remove(
      'driver-active-element-parent',
      'driver-active-element-parent-no-scroll',
    );
  }
}

function isRenderableTutorialTarget(element: HTMLElement, view: Window): boolean {
  const rect = element.getBoundingClientRect();
  const style = view.getComputedStyle(element);

  return element.isConnected
    && style.display !== 'none'
    && style.visibility !== 'hidden'
    && Number.parseFloat(style.opacity || '1') > 0
    && rect.width > 0
    && rect.height > 0;
}

function intersectRect(
  left: Pick<DOMRect, 'bottom' | 'left' | 'right' | 'top'>,
  right: Pick<DOMRect, 'bottom' | 'left' | 'right' | 'top'>,
): { readonly bottom: number; readonly left: number; readonly right: number; readonly top: number } | null {
  const intersection = {
    bottom: Math.min(left.bottom, right.bottom),
    left: Math.max(left.left, right.left),
    right: Math.min(left.right, right.right),
    top: Math.max(left.top, right.top),
  };

  return intersection.right > intersection.left && intersection.bottom > intersection.top
    ? intersection
    : null;
}

function clearTutorialState(stateHost: HTMLElement): void {
  stateHost.removeAttribute(tutorialDomAttributes.active);
  stateHost.removeAttribute(tutorialDomAttributes.step);
}

function restoreAttribute(element: HTMLElement, name: string, value: string | null): void {
  if (value === null) {
    element.removeAttribute(name);
  } else {
    element.setAttribute(name, value);
  }
}

function restoreOwnedAttribute(
  element: HTMLElement,
  name: string,
  ownedValue: string | null,
  previousValue: string | null,
): void {
  if (element.getAttribute(name) !== ownedValue) {
    return;
  }

  restoreAttribute(element, name, previousValue);
}

function isDriverOwnedMutation(record: MutationRecord): boolean {
  const target = record.target;

  if (target.nodeType !== 1) {
    return false;
  }

  const element = target as Element;

  return element.matches('.driver-overlay, .driver-popover, .driver-popover *')
    || element.closest('.driver-overlay, .driver-popover') !== null;
}

function escapeAttributeValue(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll('"', '\\"');
}

function escapeTutorialText(ownerDocument: Document, value: string): string {
  const element = ownerDocument.createElement('span');
  element.textContent = value;
  return element.innerHTML;
}
