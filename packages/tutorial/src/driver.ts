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
  resetForReplay(): void;
  waitForPendingSkip(): Promise<void>;
}

interface TutorialTargetSemanticsGuard {
  applyDriverMutation<T>(mutation: () => T): T;
  restore(driverAlreadyDestroyed?: boolean): void;
}

interface TutorialModalSemanticsGuard {
  readonly modal: HTMLElement | null;
  readonly popover: HTMLElement;
  isOwnedAttributeCurrent(attribute: TutorialModalAttribute): boolean;
  restore(): void;
}

type TutorialModalAttribute = 'aria-modal' | 'aria-owns';

interface TutorialModalAttributeGuard {
  isOwned(attribute: TutorialModalAttribute): boolean;
  restore(): void;
}

interface TutorialTargetAcknowledgeBinding {
  readonly driver: Driver;
  readonly listener: () => void;
  readonly stepId: string;
  readonly target: HTMLElement;
}

interface TutorialTargetClickMode {
  readonly acknowledgeOnTargetClick: boolean;
}

interface TutorialTargetClickState extends TutorialTargetClickMode {
  readonly driver: Driver;
  readonly stepId: string;
  readonly target: HTMLElement;
}

interface TutorialTargetRect {
  readonly bottom: number;
  readonly height: number;
  readonly left: number;
  readonly right: number;
  readonly top: number;
  readonly width: number;
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
  let targetShadowPointerStyle: HTMLStyleElement | undefined;
  let targetRestorePending = false;
  let restartPreferredOnFrame = false;
  let restartingInstance = false;
  let dismissedPresentationKey: string | null = null;
  let retryableDismissedKey: string | null = null;
  let missingTargetErrorKey: string | null = null;
  let syncModalSemantics: (() => void) | undefined;
  let targetAcknowledgeBinding: TutorialTargetAcknowledgeBinding | undefined;
  let targetClickState: TutorialTargetClickState | undefined;
  let targetHitTestFrame: number | undefined;
  let targetGeometryFrame: number | undefined;
  const pendingSkipOperations = new Set<Promise<void>>();

  const reportError = (error: unknown): void => {
    try {
      input.onError?.(error);
    } catch {
      // Error reporting must not interrupt presenter lifecycle handling.
    }
  };

  const reportActive = (active: boolean): void => {
    if (reportedActive === active) {
      return;
    }

    reportedActive = active;

    try {
      input.onActiveChange?.(active);
    } catch (error) {
      reportError(error);
    }
  };

  const scheduleRefresh = (restartPreferred = false): void => {
    restartPreferredOnFrame ||= restartPreferred;

    if (destroyed || frame !== undefined || dismissedPresentationKey !== null) {
      return;
    }

    frame = browserWindow.requestAnimationFrame(() => {
      frame = undefined;

      if (destroyed || dismissedPresentationKey !== null) {
        return;
      }

      const shouldRestartPreferred = restartPreferredOnFrame;
      restartPreferredOnFrame = false;
      const currentInstance = instance;

      if (currentInstance === null || !currentInstance.isActive()) {
        driveActiveStep();
        return;
      }

      const presentation = activePresentation;

      if (shouldRestartPreferred
        && presentation !== null
        && shouldPreferActivatableTutorialTarget(presentation)) {
        restartActiveInstance(currentInstance, presentation);
        return;
      }

      rebindActiveTarget(currentInstance, presentation);
    });
  };
  const scheduleHostRefresh = (): void => scheduleRefresh(true);

  const createInstance = (presentation: DriverTutorialPresentation<TStep>): Driver => {
    let created!: Driver;
    let modalSemanticsGuard: TutorialModalSemanticsGuard | undefined;
    let popover: HTMLElement | null = null;
    const syncCreatedModalSemantics = (): void => {
      if (popover === null) {
        return;
      }

      const modalSelector = input.modalSelector ?? '[role="dialog"][aria-modal="true"]';
      const retainCurrentModal = modalSemanticsGuard
        ?.isOwnedAttributeCurrent('aria-modal') ?? false;
      const modal = resolveUnderlyingTutorialModal(
        popover,
        presentation.step.interaction,
        created.getActiveElement(),
        modalSelector,
        modalSemanticsGuard?.modal ?? null,
        retainCurrentModal,
      );

      if (modalSemanticsGuard?.modal === modal
        && modalSemanticsGuard.popover === popover
        && (presentation.step.interaction !== 'blocked'
          || modal === null
          || retainCurrentModal)) {
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
        retryableDismissedKey = null;
        destroyInstancePreservingTarget(created);
        const skipOperation = Promise.resolve()
          .then(() => input.onSkip())
          .catch((error: unknown) => {
            if (dismissedPresentationKey === dismissedKey) {
              retryableDismissedKey = dismissedKey;
            }

            reportError(error);
          });
        pendingSkipOperations.add(skipOperation);
        void skipOperation
          .finally(() => pendingSkipOperations.delete(skipOperation))
          .catch(() => undefined);
      },
      onDestroyed: () => {
        clearTargetAcknowledgeBinding(created);
        clearTargetClickState(created);

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
          cancelTargetGeometryMonitor();
          clearTargetGeometryObservers();
          instance = null;

          if (!restartingInstance) {
            clearTutorialState(stateHost);
            reportActive(false);
          }
        }

        if (!destroyed && !restartingInstance && activePresentation !== null) {
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
        if (presentation.step.advance.kind === 'acknowledge'
          || presentation.step.interaction === 'blocked') {
          const activeTarget = created.getActiveElement();
          const acknowledgeFromTarget = activeTarget instanceof HTMLElement
            && targetClickState?.driver === created
            && targetClickState.target === activeTarget
            && targetClickState.stepId === presentation.step.id
            && targetClickState.acknowledgeOnTargetClick;
          const initialFocus = presentation.step.advance.kind !== 'acknowledge'
            || acknowledgeFromTarget
            ? closeButton
            : nextButton;
          browserWindow.queueMicrotask(() => initialFocus.focus());
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

    const targetActivatable = target !== null
      && isActivatableTutorialTarget(target, browserWindow);
    const targetClickMode = resolveTutorialTargetClickMode(
      presentation,
      target ?? undefined,
      targetActivatable,
    );
    const nextInstance = createInstance(presentation);
    instance = nextInstance;
    setTargetClickState(nextInstance, presentation, target ?? undefined, targetClickMode);
    targetSemanticsGuard?.restore();
    targetSemanticsGuard = target === null
      ? undefined
      : preserveTutorialTargetSemantics(target, browserWindow);

    try {
      nextInstance.setSteps([
        createDriveStep(
          input,
          presentation,
          target ?? undefined,
          targetClickMode.acknowledgeOnTargetClick,
          ownerDocument,
          reportError,
        ),
      ]);
      applyDriverTargetMutation(() => {
        syncTargetShadowPointerStyle(presentation, target ?? undefined, targetActivatable);
        stateHost.setAttribute(tutorialDomAttributes.active, 'true');
        stateHost.setAttribute(tutorialDomAttributes.step, presentation.step.id);
        nextInstance.drive();
      });
      downgradeInactiveTargetClickMode(
        nextInstance,
        presentation,
        target ?? undefined,
        targetClickMode,
      );
      syncModalSemantics?.();
      syncTargetGeometryObservers(presentation);
      syncTargetGeometryMonitor(nextInstance, presentation);
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

      reportError(error);
    }
  };

  const resolvePresentationTarget = (
    presentation: DriverTutorialPresentation<TStep>,
    presentationKey: string | null = activePresentationKey,
  ): HTMLElement | null => {
    if (presentation.step.target === null) {
      return null;
    }

    const presentationTarget = presentation.step.target;

    try {
      if (input.resolveTarget !== undefined) {
        return input.resolveTarget(presentationTarget, root);
      }

      return resolveVisibleTutorialTarget({
        preferActivatable: shouldPreferActivatableTutorialTarget(presentation),
        root,
        target: presentationTarget,
        targetAttribute,
        view: browserWindow,
      });
    } catch (error) {
      if (presentationKey !== null
        && presentationKey === activePresentationKey
        && missingTargetErrorKey !== presentationKey) {
        missingTargetErrorKey = presentationKey;
        reportError(error);
      }

      return null;
    }
  };

  const resizeObservationRoot = root.nodeType === 9
    ? ownerDocument.documentElement
    : root as HTMLElement;
  const mutationOptions: MutationObserverInit = {
    attributes: true,
    characterData: true,
    childList: true,
    subtree: true,
  };
  const mutationObserver = new browserWindow.MutationObserver(processMutationRecords);
  let observedShadowRoots = new Set<ShadowRoot>();
  let observingDocumentMutations = false;
  let resizeObserver: ResizeObserver | null = null;
  let intersectionObserver: IntersectionObserver | null = null;
  const observedGeometryTargets = new Set<HTMLElement>();
  const targetVisibility = new Map<HTMLElement, boolean>();

  function processMutationRecords(records: readonly MutationRecord[]): void {
    if (activePresentation === null && instance === null) {
      observeDocumentOnlyMutations();
      return;
    }

    reconcileMutationRoots();
    const hostRecords = records.filter((record) => !isDriverOwnedMutation(record));

    if (hostRecords.length > 0) {
      scheduleRefresh(hostRecords.some(isTargetSelectionMutation));
    }
  }

  function isTargetSelectionMutation(record: MutationRecord): boolean {
    const presentation = activePresentation;

    if (presentation === null
      || presentation.step.target === null
      || !shouldPreferActivatableTutorialTarget(presentation)) {
      return false;
    }

    const activeElement = instance?.getActiveElement();
    const currentTarget = activeElement instanceof HTMLElement
      && activeElement.id !== 'driver-dummy-element'
      ? activeElement
      : null;

    if (record.type === 'characterData') {
      return record.target.parentElement instanceof HTMLStyleElement
        && stylesheetMutationAffectsLookupRoot(record.target);
    }

    if (record.type === 'attributes') {
      if (isStylesheetAttributeMutation(record)
        && stylesheetMutationAffectsLookupRoot(record.target)) {
        return true;
      }

      if (!(record.target instanceof Element)) {
        return false;
      }

      const mutationTarget = record.target;
      return collectTargetSelectionElements(presentation, currentTarget)
        .some((target) => attributeMutationMayAffectTarget(target, mutationTarget));
    }

    if (record.type !== 'childList') {
      return false;
    }

    const changedNodes = [...record.addedNodes, ...record.removedNodes];
    const touchesLookupRoot = childListTouchesLookupRoot(record, changedNodes);

    if (isStylesheetDomMutation(record, changedNodes)
      && stylesheetMutationAffectsLookupRoot(record.target)) {
      return true;
    }

    if (!touchesLookupRoot) {
      return false;
    }

    if (currentTarget !== null && !currentTarget.isConnected) {
      return true;
    }

    if (currentTarget !== null && changedNodes.some(
      (node) => node instanceof Element && isComposedAncestorOrSelf(currentTarget, node),
    )) {
      return true;
    }

    return input.resolveTarget === undefined && changedNodes.some(
      (node) => mutationNodeMayContainTarget(node, createTargetSelector(presentation)),
    );
  }

  function childListTouchesLookupRoot(
    record: MutationRecord,
    changedNodes: readonly Node[],
  ): boolean {
    if (root.nodeType === 9 || isNodeWithinLookupRoot(record.target)) {
      return true;
    }

    return changedNodes.some((node) => {
      if (node === root) {
        return true;
      }

      return node instanceof Element && isComposedAncestorOrSelf(root as HTMLElement, node);
    });
  }

  function isNodeWithinLookupRoot(node: Node): boolean {
    if (root.nodeType === 9) {
      return true;
    }

    const element = node instanceof ShadowRoot
      ? node.host
      : node instanceof Element
        ? node
        : node.parentElement;
    return element !== null && isComposedAncestorOrSelf(element, root as HTMLElement);
  }

  function isStylesheetDomMutation(
    record: MutationRecord,
    changedNodes: readonly Node[],
  ): boolean {
    return isStylesheetElement(record.target)
      || changedNodes.some(nodeContainsStylesheetElement);
  }

  function isStylesheetAttributeMutation(record: MutationRecord): boolean {
    if (record.target instanceof HTMLStyleElement) {
      return true;
    }

    return record.target instanceof HTMLLinkElement
      && ['disabled', 'href', 'media', 'rel'].includes(record.attributeName ?? '');
  }

  function stylesheetMutationAffectsLookupRoot(node: Node): boolean {
    const treeScope = node.getRootNode();

    if (treeScope === ownerDocument) {
      return true;
    }

    const presentation = activePresentation;

    if (presentation === null) {
      return false;
    }

    return collectTargetSelectionElements(presentation)
      .some((target) => composedElementUsesTreeScope(target, treeScope));
  }

  function collectTargetSelectionElements(
    presentation: DriverTutorialPresentation<TStep>,
    currentTarget?: HTMLElement | null,
  ): HTMLElement[] {
    const targets = new Set<HTMLElement>();
    const activeTarget = currentTarget ?? instance?.getActiveElement();

    if (activeTarget instanceof HTMLElement && activeTarget.id !== 'driver-dummy-element') {
      targets.add(activeTarget);
    }

    if (input.resolveTarget === undefined && presentation.step.target !== null) {
      for (const candidate of findComposedTutorialCandidates(
        root,
        createTargetSelector(presentation),
      )) {
        targets.add(candidate);
      }
    }

    return [...targets];
  }

  function attributeMutationMayAffectTarget(
    target: HTMLElement,
    mutationTarget: Element,
  ): boolean {
    if (isComposedAncestorOrSelf(target, mutationTarget)) {
      return true;
    }

    if (target.getRootNode() !== mutationTarget.getRootNode()) {
      return false;
    }

    if (target.getRootNode() instanceof ShadowRoot) {
      return true;
    }

    if (root instanceof HTMLElement && isNodeWithinLookupRoot(mutationTarget)) {
      return true;
    }

    if (target.contains(mutationTarget)
      || target.parentElement !== null
        && mutationTarget.parentElement === target.parentElement) {
      return true;
    }

    return composedAncestorBranchesAreSiblings(target, mutationTarget);
  }

  function composedAncestorBranchesAreSiblings(
    target: HTMLElement,
    mutationTarget: Element,
  ): boolean {
    const targetAncestors = collectComposedAncestors(target);
    let mutationAncestor: Element | null = mutationTarget;

    while (mutationAncestor !== null) {
      const mutationParent = getComposedParentElement(mutationAncestor);

      if (mutationParent !== null
        && mutationParent !== ownerDocument.body
        && mutationParent !== ownerDocument.documentElement
        && targetAncestors.some(
          (targetAncestor) => getComposedParentElement(targetAncestor) === mutationParent,
        )) {
        return true;
      }

      mutationAncestor = mutationParent;
    }

    return false;
  }

  function collectComposedAncestors(element: Element): Element[] {
    const ancestors: Element[] = [];
    let current: Element | null = element;

    while (current !== null) {
      ancestors.push(current);
      current = getComposedParentElement(current);
    }

    return ancestors;
  }

  function nodeContainsStylesheetElement(node: Node): boolean {
    return isStylesheetElement(node)
      || [...node.childNodes].some(nodeContainsStylesheetElement);
  }

  function isStylesheetElement(node: Node): boolean {
    if (node instanceof HTMLStyleElement) {
      return true;
    }

    return node instanceof HTMLLinkElement
      && node.rel.toLowerCase().split(/\s+/u).includes('stylesheet');
  }

  function createTargetSelector(presentation: DriverTutorialPresentation<TStep>): string {
    return `[${targetAttribute}="${escapeAttributeValue(presentation.step.target ?? '')}"]`;
  }

  function mutationNodeMayContainTarget(node: Node, selector: string): boolean {
    if (node instanceof HTMLElement && (node.matches(selector) || node.shadowRoot !== null)) {
      return true;
    }

    return [...node.childNodes].some((child) => mutationNodeMayContainTarget(child, selector));
  }

  function reconcileMutationRoots(force = false): void {
    if (destroyed) {
      return;
    }

    if (activePresentation === null && instance === null) {
      observeDocumentOnlyMutations(force);
      return;
    }

    const nextShadowRoots = new Set(findOpenTutorialShadowRoots(ownerDocument));
    const rootsChanged = nextShadowRoots.size !== observedShadowRoots.size
      || [...nextShadowRoots].some((shadowRoot) => !observedShadowRoots.has(shadowRoot));

    if (!force && observingDocumentMutations && !rootsChanged) {
      return;
    }

    mutationObserver.disconnect();
    mutationObserver.observe(ownerDocument.documentElement, mutationOptions);
    observingDocumentMutations = true;

    for (const shadowRoot of nextShadowRoots) {
      mutationObserver.observe(shadowRoot, mutationOptions);
    }

    observedShadowRoots = nextShadowRoots;
  }

  function observeDocumentOnlyMutations(force = false): void {
    if (!force && observingDocumentMutations && observedShadowRoots.size === 0) {
      return;
    }

    mutationObserver.disconnect();
    mutationObserver.observe(ownerDocument.documentElement, mutationOptions);
    observingDocumentMutations = true;
    observedShadowRoots.clear();
  }

  function syncTargetGeometryObservers(
    presentation: DriverTutorialPresentation<TStep>,
  ): void {
    const nextTargets = shouldPreferActivatableTutorialTarget(presentation)
      ? new Set(collectTargetSelectionElements(presentation))
      : new Set<HTMLElement>();

    for (const target of observedGeometryTargets) {
      if (nextTargets.has(target)) {
        continue;
      }

      intersectionObserver?.unobserve(target);

      if (target !== resizeObservationRoot) {
        resizeObserver?.unobserve(target);
      }

      observedGeometryTargets.delete(target);
      targetVisibility.delete(target);
    }

    for (const target of nextTargets) {
      if (observedGeometryTargets.has(target)) {
        continue;
      }

      observedGeometryTargets.add(target);
      targetVisibility.set(target, isVisibleTutorialTarget(target, browserWindow));
      resizeObserver?.observe(target);
      intersectionObserver?.observe(target);
    }
  }

  function clearTargetGeometryObservers(): void {
    for (const target of observedGeometryTargets) {
      intersectionObserver?.unobserve(target);

      if (target !== resizeObservationRoot) {
        resizeObserver?.unobserve(target);
      }
    }

    intersectionObserver?.takeRecords();
    observedGeometryTargets.clear();
    targetVisibility.clear();
  }

  function syncTargetGeometryMonitor(
    currentInstance: Driver,
    presentation: DriverTutorialPresentation<TStep>,
  ): void {
    cancelTargetGeometryMonitor();

    if (!shouldPreferActivatableTutorialTarget(presentation)) {
      return;
    }

    const target = currentInstance.getActiveElement();

    if (!(target instanceof HTMLElement) || target.id === 'driver-dummy-element') {
      return;
    }

    const presentationKey = activePresentationKey;
    let previousRect = readTutorialTargetRect(target);
    let previousVisible = isVisibleTutorialTargetWithRect(target, browserWindow, previousRect);
    const monitor = (): void => {
      targetGeometryFrame = undefined;
      const currentPresentation = activePresentation;

      if (destroyed
        || instance !== currentInstance
        || !currentInstance.isActive()
        || currentPresentation === null
        || activePresentationKey !== presentationKey
        || !shouldPreferActivatableTutorialTarget(currentPresentation)
        || currentInstance.getActiveElement() !== target) {
        return;
      }

      const nextRect = readTutorialTargetRect(target);
      const rectChanged = !tutorialTargetRectsEqual(previousRect, nextRect);
      const selectionInvalid = !target.isConnected
        || !isNodeWithinLookupRoot(target)
        || (input.resolveTarget === undefined
          && !target.matches(createTargetSelector(currentPresentation)));

      if (rectChanged || selectionInvalid) {
        const nextVisible = !selectionInvalid
          && isVisibleTutorialTargetWithRect(target, browserWindow, nextRect);

        if (selectionInvalid || nextVisible !== previousVisible) {
          scheduleHostRefresh();
        } else {
          scheduleRefresh();
        }

        previousRect = nextRect;
        previousVisible = nextVisible;
      }

      targetGeometryFrame = browserWindow.requestAnimationFrame(monitor);
    };
    targetGeometryFrame = browserWindow.requestAnimationFrame(monitor);
  }

  function cancelTargetGeometryMonitor(): void {
    if (targetGeometryFrame === undefined) {
      return;
    }

    browserWindow.cancelAnimationFrame(targetGeometryFrame);
    targetGeometryFrame = undefined;
  }

  function recordTargetVisibilityChange(target: HTMLElement): boolean {
    const previous = targetVisibility.get(target);
    const next = isVisibleTutorialTarget(target, browserWindow);
    targetVisibility.set(target, next);
    return previous !== undefined && previous !== next;
  }

  function processIntersectionRecords(entries: IntersectionObserverEntry[]): void {
    const targetSelectionChanged = entries.some((entry) => (
      entry.target instanceof HTMLElement
      && observedGeometryTargets.has(entry.target)
      && recordTargetVisibilityChange(entry.target)
    ));

    if (targetSelectionChanged) {
      scheduleHostRefresh();
    }
  }

  function processResizeRecords(entries: ResizeObserverEntry[]): void {
    const targetSelectionChanged = entries.some((entry) => (
      entry.target instanceof HTMLElement
      && observedGeometryTargets.has(entry.target)
      && recordTargetVisibilityChange(entry.target)
    ));

    if (targetSelectionChanged) {
      scheduleHostRefresh();
      return;
    }

    if (entries.some((entry) => entry.target === resizeObservationRoot)) {
      scheduleViewportRefresh();
    }
  }

  function scheduleViewportRefresh(): void {
    const presentation = activePresentation;
    const activeElement = instance?.getActiveElement();
    const restartPreferred = presentation !== null
      && shouldPreferActivatableTutorialTarget(presentation)
      && (!(activeElement instanceof HTMLElement)
        || !isVisibleTutorialTarget(activeElement, browserWindow));
    scheduleRefresh(restartPreferred);
  }

  reconcileMutationRoots(true);
  resizeObserver = typeof browserWindow.ResizeObserver === 'function'
    ? new browserWindow.ResizeObserver(processResizeRecords)
    : null;
  intersectionObserver = typeof browserWindow.IntersectionObserver === 'function'
    ? new browserWindow.IntersectionObserver(processIntersectionRecords, { threshold: 0 })
    : null;
  resizeObserver?.observe(resizeObservationRoot);
  ownerDocument.addEventListener('scroll', scheduleViewportRefresh, true);
  browserWindow.addEventListener('resize', scheduleViewportRefresh);
  browserWindow.visualViewport?.addEventListener('resize', scheduleViewportRefresh);
  browserWindow.visualViewport?.addEventListener('scroll', scheduleViewportRefresh);
  browserWindow.addEventListener('orientationchange', scheduleViewportRefresh);

  return {
    destroy() {
      if (destroyed) {
        return;
      }

      destroyed = true;
      activePresentation = null;
      activePresentationKey = null;
      dismissedPresentationKey = null;
      retryableDismissedKey = null;
      missingTargetErrorKey = null;
      mutationObserver.disconnect();
      observingDocumentMutations = false;
      observedShadowRoots.clear();
      cancelTargetGeometryMonitor();
      clearTargetGeometryObservers();
      resizeObserver?.disconnect();
      intersectionObserver?.disconnect();
      ownerDocument.removeEventListener('scroll', scheduleViewportRefresh, true);
      browserWindow.removeEventListener('resize', scheduleViewportRefresh);
      browserWindow.visualViewport?.removeEventListener('resize', scheduleViewportRefresh);
      browserWindow.visualViewport?.removeEventListener('scroll', scheduleViewportRefresh);
      browserWindow.removeEventListener('orientationchange', scheduleViewportRefresh);

      if (frame !== undefined) {
        browserWindow.cancelAnimationFrame(frame);
      }

      if (instance !== null) {
        destroyInstancePreservingTarget(instance);
      }

      instance = null;
      targetSemanticsGuard = undefined;
      targetShadowPointerStyle?.remove();
      targetShadowPointerStyle = undefined;
      clearTargetAcknowledgeBinding();
      clearTargetClickState();
      clearTutorialState(stateHost);
      reportActive(false);
    },
    present(presentation) {
      if (destroyed) {
        return;
      }

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
        && nextKey !== null
        && (dismissedPresentationKey !== nextKey || retryableDismissedKey === nextKey)) {
        dismissedPresentationKey = null;
        retryableDismissedKey = null;
      }

      if (activePresentationKey !== nextKey) {
        missingTargetErrorKey = null;
      }

      if (activePresentationKey === nextKey) {
        activePresentation = presentation;
        reconcileMutationRoots(true);
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

      reconcileMutationRoots(true);
      clearTutorialState(stateHost);
      reportActive(false);
      scheduleRefresh();
    },
    refresh() {
      // attachShadow() itself emits no mutation, so explicit refresh also discovers new roots.
      reconcileMutationRoots();
      scheduleHostRefresh();
    },
    resetForReplay() {
      dismissedPresentationKey = null;
      retryableDismissedKey = null;
      missingTargetErrorKey = null;
      scheduleRefresh();
    },
    async waitForPendingSkip() {
      while (pendingSkipOperations.size > 0) {
        await Promise.allSettled(pendingSkipOperations);
      }
    },
  };

  function restartActiveInstance(
    currentInstance: Driver,
    presentation: DriverTutorialPresentation<TStep>,
  ): void {
    const presentationKey = activePresentationKey;
    restartingInstance = true;

    try {
      applyDriverTargetMutation(() => destroyInstancePreservingTarget(currentInstance));
    } finally {
      restartingInstance = false;
    }

    if (!destroyed
      && dismissedPresentationKey === null
      && activePresentation === presentation
      && activePresentationKey === presentationKey) {
      driveActiveStep();
    }

    if (instance === null || !instance.isActive()) {
      clearTutorialState(stateHost);
      reportActive(false);
    }
  }

  function rebindActiveTarget(
    currentInstance: Driver,
    presentation: DriverTutorialPresentation<TStep> | null,
  ): void {
    if (presentation !== null && shouldPreferActivatableTutorialTarget(presentation)) {
      if (input.resolveTarget !== undefined && presentation.step.target !== null) {
        const presentationKey = activePresentationKey;
        const target = resolvePresentationTarget(presentation, presentationKey);

        if (destroyed
          || activePresentation !== presentation
          || activePresentationKey !== presentationKey
          || instance !== currentInstance
          || !currentInstance.isActive()) {
          return;
        }

        const activeElement = currentInstance.getActiveElement();
        const targetUnchanged = target === activeElement
          || (target === null && activeElement?.id === 'driver-dummy-element');

        if (!targetUnchanged) {
          restartActiveInstance(currentInstance, presentation);
          return;
        }
      }

      applyDriverTargetMutation(() => currentInstance.refresh());
      syncModalSemantics?.();
      return;
    }

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

        rebindTarget(currentInstance, presentation, undefined);
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

    rebindTarget(currentInstance, presentation, target);
  }

  function rebindTarget(
    currentInstance: Driver,
    presentation: DriverTutorialPresentation<TStep>,
    target: HTMLElement | undefined,
  ): void {
    const previousTarget = currentInstance.getActiveElement();
    targetSemanticsGuard?.restore();
    const restorePreviousTarget = previousTarget === target
      || !(previousTarget instanceof HTMLElement)
      || previousTarget.id === 'driver-dummy-element'
      ? undefined
      : captureTutorialTargetSemantics(previousTarget, target?.parentElement ?? null);
    targetSemanticsGuard = target === undefined
      ? undefined
      : preserveTutorialTargetSemantics(target, browserWindow);
    const targetActivatable = target !== undefined
      && isActivatableTutorialTarget(target, browserWindow);
    const targetClickMode = resolveTutorialTargetClickMode(presentation, target, targetActivatable);
    applyTargetClickMode(currentInstance, presentation, target, targetClickMode, targetActivatable);
    downgradeInactiveTargetClickMode(currentInstance, presentation, target, targetClickMode);
    restorePreviousTarget?.();
    syncModalSemantics?.();
  }

  function applyTargetClickMode(
    currentInstance: Driver,
    presentation: DriverTutorialPresentation<TStep>,
    target: HTMLElement | undefined,
    mode: TutorialTargetClickMode,
    targetActivatable: boolean,
  ): void {
    const nextStep = createDriveStep(
      input,
      presentation,
      target,
      mode.acknowledgeOnTargetClick,
      ownerDocument,
      reportError,
    );
    clearTargetAcknowledgeBinding(currentInstance);
    setTargetClickState(currentInstance, presentation, target, mode);
    applyDriverTargetMutation(() => {
      syncTargetShadowPointerStyle(presentation, target, targetActivatable);
      currentInstance.highlight(nextStep);
    });
  }

  function downgradeInactiveTargetClickMode(
    currentInstance: Driver,
    presentation: DriverTutorialPresentation<TStep>,
    target: HTMLElement | undefined,
    mode: TutorialTargetClickMode,
  ): void {
    if (mode.acknowledgeOnTargetClick
      && target !== undefined
      && (!isActivatableTutorialTarget(target, browserWindow)
        || !isShadowTutorialTargetHitTestable(target))) {
      applyTargetClickMode(
        currentInstance,
        presentation,
        target,
        { acknowledgeOnTargetClick: false },
        true,
      );
    } else if (mode.acknowledgeOnTargetClick && target !== undefined) {
      scheduleShadowTargetHitTest(currentInstance, presentation, target);
    }

    syncTargetAcknowledgeBinding(currentInstance, presentation);
  }

  function isShadowTutorialTargetHitTestable(target: HTMLElement): boolean {
    if (!(target.getRootNode() instanceof ShadowRoot)) {
      return true;
    }

    if (typeof ownerDocument.elementFromPoint !== 'function') {
      return true;
    }

    const shadowRoots: ShadowRoot[] = [];
    let current: Element | null = target;

    while (current !== null) {
      const treeScope = current.getRootNode();

      if (!(treeScope instanceof ShadowRoot)) {
        break;
      }

      shadowRoots.unshift(treeScope);
      current = treeScope.host;
    }

    const visibleRect = intersectRect(
      target.getBoundingClientRect(),
      resolveViewportRect(browserWindow),
    );

    if (visibleRect === null) {
      return false;
    }

    const x = (visibleRect.left + visibleRect.right) / 2;
    const y = (visibleRect.top + visibleRect.bottom) / 2;
    let hit = ownerDocument.elementFromPoint(x, y);
    const outerHost = shadowRoots[0]?.host;

    if (!(hit instanceof Element)
      || outerHost === undefined
      || !isComposedAncestorOrSelf(hit, outerHost)) {
      return false;
    }

    for (const [index, shadowRoot] of shadowRoots.entries()) {
      if (typeof shadowRoot.elementFromPoint !== 'function') {
        return false;
      }

      hit = shadowRoot.elementFromPoint(x, y);
      const expectedTarget = shadowRoots[index + 1]?.host ?? target;

      if (!(hit instanceof Element)
        || !isComposedAncestorOrSelf(hit, expectedTarget)) {
        return false;
      }
    }

    return true;
  }

  function scheduleShadowTargetHitTest(
    currentInstance: Driver,
    presentation: DriverTutorialPresentation<TStep>,
    target: HTMLElement,
  ): void {
    if (!(target.getRootNode() instanceof ShadowRoot)
      || typeof ownerDocument.elementFromPoint !== 'function') {
      return;
    }

    cancelShadowTargetHitTest();
    const state = targetClickState;
    const presentationKey = activePresentationKey;
    targetHitTestFrame = browserWindow.requestAnimationFrame(() => {
      targetHitTestFrame = undefined;

      if (destroyed
        || instance !== currentInstance
        || !currentInstance.isActive()
        || activePresentation !== presentation
        || activePresentationKey !== presentationKey
        || targetClickState !== state
        || state?.acknowledgeOnTargetClick !== true
        || isShadowTutorialTargetHitTestable(target)) {
        return;
      }

      applyTargetClickMode(
        currentInstance,
        presentation,
        target,
        { acknowledgeOnTargetClick: false },
        true,
      );
      syncTargetAcknowledgeBinding(currentInstance, presentation);
      syncModalSemantics?.();
    });
  }

  function cancelShadowTargetHitTest(): void {
    if (targetHitTestFrame === undefined) {
      return;
    }

    browserWindow.cancelAnimationFrame(targetHitTestFrame);
    targetHitTestFrame = undefined;
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
    const target = String(presentation.step.target);
    reportError(new Error(`Tutorial target was not found: ${target}`));
  }

  function syncTargetAcknowledgeBinding(
    currentInstance: Driver,
    presentation: DriverTutorialPresentation<TStep>,
  ): void {
    clearTargetAcknowledgeBinding(currentInstance);
    const state = targetClickState;

    if (state === undefined
      || state.driver !== currentInstance
      || state.stepId !== presentation.step.id
      || !state.acknowledgeOnTargetClick) {
      return;
    }

    const { target } = state;
    const presentationKey = activePresentationKey;
    let acknowledgementQueued = false;
    const listener = (): void => {
      const targetActivatableAtCapture = isActivatableTutorialTarget(target, browserWindow);

      if (acknowledgementQueued || !targetActivatableAtCapture) {
        return;
      }

      acknowledgementQueued = true;
      browserWindow.queueMicrotask(() => {
        acknowledgementQueued = false;

        if (destroyed
          || instance !== currentInstance
          || activePresentationKey !== presentationKey
          || targetClickState !== state) {
          return;
        }

        try {
          input.onAcknowledge(presentation.step.id);
        } catch (error) {
          reportError(error);
        }
      });
    };
    target.addEventListener('click', listener, true);
    targetAcknowledgeBinding = {
      driver: currentInstance,
      listener,
      stepId: presentation.step.id,
      target,
    };
  }

  function clearTargetAcknowledgeBinding(currentInstance?: Driver): void {
    const binding = targetAcknowledgeBinding;

    if (binding === undefined
      || (currentInstance !== undefined && binding.driver !== currentInstance)) {
      return;
    }

    binding.target.removeEventListener('click', binding.listener, true);
    targetAcknowledgeBinding = undefined;
  }

  function setTargetClickState(
    currentInstance: Driver,
    presentation: DriverTutorialPresentation<TStep>,
    target: HTMLElement | undefined,
    mode: TutorialTargetClickMode,
  ): void {
    cancelShadowTargetHitTest();
    targetClickState = target === undefined
      ? undefined
      : {
          ...mode,
          driver: currentInstance,
          stepId: presentation.step.id,
          target,
        };
  }

  function clearTargetClickState(currentInstance?: Driver): void {
    if (currentInstance !== undefined && targetClickState?.driver !== currentInstance) {
      return;
    }

    cancelShadowTargetHitTest();
    targetClickState = undefined;
  }

  function syncTargetShadowPointerStyle(
    presentation: DriverTutorialPresentation<TStep>,
    target: HTMLElement | undefined,
    targetActivatable: boolean,
  ): void {
    targetShadowPointerStyle?.remove();
    targetShadowPointerStyle = undefined;

    if (target === undefined
      || !targetActivatable
      || !shouldAllowTutorialTargetInteraction(presentation)) {
      return;
    }

    const targetRoot = target.getRootNode();

    if (!(targetRoot instanceof ShadowRoot)) {
      return;
    }

    const targetPosition = browserWindow.getComputedStyle(target).position;
    const positionRule = targetPosition === '' || targetPosition === 'static'
      ? 'position: relative !important;'
      : '';
    const style = ownerDocument.createElement('style');
    style.textContent = `
      .driver-active-element:not(.driver-no-interaction) {
        ${positionRule}
        z-index: 1000000001 !important;
        pointer-events: auto !important;
      }
      .driver-active-element:not(.driver-no-interaction) * {
        pointer-events: auto !important;
      }
      .driver-no-interaction,
      .driver-no-interaction * {
        pointer-events: none !important;
      }
    `;
    targetRoot.appendChild(style);
    targetShadowPointerStyle = style;
  }

  function destroyInstancePreservingTarget(currentInstance: Driver): void {
    cancelTargetGeometryMonitor();
    clearTargetGeometryObservers();
    const target = currentInstance.getActiveElement();
    targetSemanticsGuard?.restore();
    targetSemanticsGuard = undefined;
    targetShadowPointerStyle?.remove();
    targetShadowPointerStyle = undefined;
    const restoreAfterDestroy = !(target instanceof HTMLElement)
      ? undefined
      : captureTutorialTargetSemantics(target);
    targetRestorePending = true;
    currentInstance.destroy();
    targetRestorePending = false;
    restoreAfterDestroy?.();
  }

  function applyDriverTargetMutation<T>(mutation: () => T): T {
    processMutationRecords(mutationObserver.takeRecords());
    mutationObserver.disconnect();

    try {
      return targetSemanticsGuard === undefined
        ? mutation()
        : targetSemanticsGuard.applyDriverMutation(mutation);
    } finally {
      if (!destroyed) {
        reconcileMutationRoots(true);
      }
    }
  }

  function resolveTutorialTargetClickMode(
    presentation: DriverTutorialPresentation<TStep>,
    target: HTMLElement | undefined,
    targetActivatable: boolean,
  ): TutorialTargetClickMode {
    return {
      acknowledgeOnTargetClick: target !== undefined
        && presentation.acknowledgeOnTargetClick === true
        && presentation.step.advance.kind === 'acknowledge'
        && presentation.step.target !== null
        && target.id !== 'driver-dummy-element'
        && targetActivatable,
    };
  }
}

export function resolveVisibleTutorialTarget(input: {
  readonly preferActivatable?: boolean;
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
  const candidates = findComposedTutorialCandidates(root, selector);

  if (input.preferActivatable === true) {
    return candidates.find(
      (element) => isActivatableTutorialTarget(element, view)
        && isVisibleTutorialTarget(element, view),
    )
      ?? candidates.find((element) => (
        isActivatableTutorialTarget(element, view) && isEligibleTutorialTarget(element, view)
      ))
      ?? candidates.find((element) => isVisibleTutorialTarget(element, view))
      ?? candidates.find((element) => isEligibleTutorialTarget(element, view))
      ?? null;
  }

  return candidates.find((element) => isVisibleTutorialTarget(element, view))
    ?? candidates.find((element) => isEligibleTutorialTarget(element, view))
    ?? null;
}

export function isVisibleTutorialTarget(element: HTMLElement, view: Window = window): boolean {
  return isVisibleTutorialTargetWithRect(element, view, element.getBoundingClientRect());
}

function isVisibleTutorialTargetWithRect(
  element: HTMLElement,
  view: Window,
  rect: TutorialTargetRect,
): boolean {
  if (!isEligibleTutorialTargetWithRect(element, view, rect)) {
    return false;
  }

  let visible = intersectRect(rect, resolveViewportRect(view));
  let ancestor = getComposedParentElement(element);

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

    ancestor = getComposedParentElement(ancestor);
  }

  return visible !== null && visible.right > visible.left && visible.bottom > visible.top;
}

function readTutorialTargetRect(element: HTMLElement): TutorialTargetRect {
  const rect = element.getBoundingClientRect();
  return {
    bottom: rect.bottom,
    height: rect.height,
    left: rect.left,
    right: rect.right,
    top: rect.top,
    width: rect.width,
  };
}

function tutorialTargetRectsEqual(left: TutorialTargetRect, right: TutorialTargetRect): boolean {
  return left.bottom === right.bottom
    && left.height === right.height
    && left.left === right.left
    && left.right === right.right
    && left.top === right.top
    && left.width === right.width;
}

function resolveViewportRect(
  view: Window,
): { readonly bottom: number; readonly left: number; readonly right: number; readonly top: number } {
  const visualViewport = view.visualViewport;

  if (visualViewport !== undefined
    && visualViewport !== null
    && Number.isFinite(visualViewport.offsetLeft)
    && Number.isFinite(visualViewport.offsetTop)
    && Number.isFinite(visualViewport.width)
    && Number.isFinite(visualViewport.height)
    && visualViewport.width > 0
    && visualViewport.height > 0) {
    return {
      bottom: visualViewport.offsetTop + visualViewport.height,
      left: visualViewport.offsetLeft,
      right: visualViewport.offsetLeft + visualViewport.width,
      top: visualViewport.offsetTop,
    };
  }

  return {
    bottom: view.innerHeight,
    left: 0,
    right: view.innerWidth,
    top: 0,
  };
}

export function bindTutorialReplayTrigger<TDefinition extends TutorialDefinition>(input: {
  readonly beforeReplay?: () => Promise<void> | void;
  readonly director: TutorialDirector<TDefinition>;
  readonly element: HTMLElement;
  readonly onError?: (error: unknown) => void;
  readonly presenter: Pick<DriverTutorialPresenter, 'resetForReplay' | 'waitForPendingSkip'>;
}): () => void {
  let pending = false;
  const reportError = (error: unknown): void => {
    try {
      input.onError?.(error);
    } catch {
      // Error reporting must not interrupt replay trigger lifecycle handling.
    }
  };
  const listener = (): void => {
    if (pending) {
      return;
    }

    pending = true;
    void Promise.resolve()
      .then(() => input.presenter.waitForPendingSkip())
      .then(() => input.beforeReplay?.())
      .then(() => input.presenter.waitForPendingSkip())
      .then(() => input.director.replay())
      .then(() => input.presenter.resetForReplay())
      .catch(reportError)
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
  acknowledgeOnTargetClick: boolean,
  ownerDocument: Document,
  reportError: (error: unknown) => void,
): DriveStep {
  const { step } = presentation;
  const actionGated = step.advance.kind === 'action' || step.advance.kind === 'signal';
  const targetInteraction = presentation.allowTargetInteraction === true
    || acknowledgeOnTargetClick
    || step.interaction === 'target'
    || step.interaction === 'gameplay';

  return {
    ...(target === undefined ? {} : { element: target }),
    // The presenter owns target clicks so Shadow DOM retargeting cannot hide them from Driver.
    advanceOnClick: false,
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
      onNextClick: () => {
        try {
          input.onAcknowledge(step.id);
        } catch (error) {
          reportError(error);
        }
      },
    },
  };
}

function shouldAllowTutorialTargetInteraction<TStep extends TutorialStep>(
  presentation: DriverTutorialPresentation<TStep>,
): boolean {
  const { step } = presentation;
  return presentation.allowTargetInteraction === true
    || (presentation.acknowledgeOnTargetClick === true
      && step.advance.kind === 'acknowledge')
    || step.interaction === 'target'
    || step.interaction === 'gameplay';
}

function shouldPreferActivatableTutorialTarget<TStep extends TutorialStep>(
  presentation: DriverTutorialPresentation<TStep>,
): boolean {
  const { step } = presentation;
  const targetInteraction = presentation.allowTargetInteraction === true
    || step.interaction === 'target'
    || step.interaction === 'gameplay';
  const acknowledgeOnTargetClick = presentation.acknowledgeOnTargetClick === true
    && step.advance.kind === 'acknowledge';
  const targetGated = targetInteraction
    && (step.advance.kind === 'action' || step.advance.kind === 'signal');

  return acknowledgeOnTargetClick || targetGated;
}

function resolveUnderlyingTutorialModal(
  popover: HTMLElement,
  interaction: TutorialStep['interaction'],
  activeElement: Element | undefined,
  modalSelector: string,
  currentModal: HTMLElement | null,
  retainCurrentModal: boolean,
): HTMLElement | null {
  const activeModal = findClosestComposedTutorialModal(activeElement, modalSelector);
  const view = popover.ownerDocument.defaultView;
  const isRenderableModal = (candidate: HTMLElement | null): candidate is HTMLElement => (
    candidate !== null
    && candidate !== popover
    && !popover.contains(candidate)
    && view !== null
    && isEligibleUnderlyingTutorialModal(candidate, view)
  );
  const hostReactivatedCurrentModal = currentModal?.getAttribute('aria-modal')
    ?.toLowerCase() === 'true';
  const canSelectCurrentModal = interaction !== 'blocked'
    || retainCurrentModal
    || hostReactivatedCurrentModal;
  const isSelectableModal = (candidate: HTMLElement | null): candidate is HTMLElement => (
    isRenderableModal(candidate)
    && (candidate !== currentModal || canSelectCurrentModal)
  );
  const renderableActiveModal = isSelectableModal(activeModal) ? activeModal : null;
  const renderableCurrentModal = isRenderableModal(currentModal) ? currentModal : null;

  if (interaction !== 'blocked') {
    return renderableActiveModal;
  }

  if (retainCurrentModal
    && activeElement !== undefined
    && renderableCurrentModal?.contains(activeElement) === true) {
    return renderableCurrentModal;
  }

  return renderableActiveModal
    ?? (canSelectCurrentModal ? renderableCurrentModal : null)
    ?? findComposedTutorialCandidates(popover.ownerDocument, modalSelector)
      .find(isSelectableModal)
    ?? null;
}

function findClosestComposedTutorialModal(
  activeElement: Element | undefined,
  selector: string,
): HTMLElement | null {
  let current: Element | null = activeElement ?? null;

  while (current !== null) {
    if (current instanceof HTMLElement && current.matches(selector)) {
      return current;
    }

    current = getComposedParentElement(current);
  }

  return null;
}

function findComposedTutorialCandidates(
  root: Document | HTMLElement,
  selector: string,
): HTMLElement[] {
  const matches: HTMLElement[] = [];
  visitComposedTutorialElements(root, (element) => {
    if (element instanceof HTMLElement && element.matches(selector)) {
      matches.push(element);
    }
  });
  return matches;
}

function findOpenTutorialShadowRoots(ownerDocument: Document): ShadowRoot[] {
  const shadowRoots: ShadowRoot[] = [];
  visitComposedTutorialElements(ownerDocument, (element) => {
    if (element.shadowRoot !== null) {
      shadowRoots.push(element.shadowRoot);
    }
  });
  return shadowRoots;
}

function visitComposedTutorialElements(
  root: Document | HTMLElement,
  visitor: (element: Element) => void,
): void {
  const visited = new Set<Element>();
  const visit = (element: Element): void => {
    if (visited.has(element)) {
      return;
    }

    visited.add(element);
    visitor(element);

    visitComposedChildren(element);
  };
  const visitChildren = (parent: ParentNode): void => {
    for (const child of parent.children) {
      visit(child);
    }
  };
  const visitComposedChildren = (parent: Document | Element): void => {
    if (parent instanceof Element && parent.shadowRoot !== null) {
      visitChildren(parent.shadowRoot);
      return;
    }

    if (parent instanceof HTMLSlotElement) {
      const assignedElements = parent.assignedElements({ flatten: true });

      if (assignedElements.length > 0) {
        for (const assignedElement of assignedElements) {
          visit(assignedElement);
        }

        return;
      }
    }

    visitChildren(parent);
  };

  visitComposedChildren(root);
}

function configureTutorialModalSemantics(
  popover: HTMLElement,
  interaction: TutorialStep['interaction'],
  underlyingModal: HTMLElement | null,
): TutorialModalSemanticsGuard {
  const ownedAttributes = new Map<TutorialModalAttribute, string>();

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

  const attributeGuard = underlyingModal === null
    ? null
    : preserveTutorialModalSemantics(underlyingModal, ownedAttributes, popover.ownerDocument);

  return {
    isOwnedAttributeCurrent: (attribute) => attributeGuard?.isOwned(attribute) ?? false,
    modal: underlyingModal,
    popover,
    restore: () => attributeGuard?.restore(),
  };
}

function preserveTutorialModalSemantics(
  element: HTMLElement,
  ownedAttributes: ReadonlyMap<TutorialModalAttribute, string>,
  ownerDocument: Document,
): TutorialModalAttributeGuard {
  const view = ownerDocument.defaultView;

  if (view === null || ownedAttributes.size === 0) {
    return {
      isOwned: () => false,
      restore: () => undefined,
    };
  }

  const previous = new Map<TutorialModalAttribute, string | null>();
  const hostValues = new Map<TutorialModalAttribute, string | null>();
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
    return {
      isOwned: () => false,
      restore: () => undefined,
    };
  }

  const observer = new view.MutationObserver(captureHostMutations);
  observer.observe(element, {
    attributeFilter: [...previous.keys()],
    attributes: true,
  });

  return {
    isOwned(attribute) {
      captureHostMutations(observer.takeRecords());
      return previous.has(attribute)
        && !hostValues.has(attribute)
        && element.getAttribute(attribute) === ownedAttributes.get(attribute);
    },
    restore() {
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
    },
  };
}

function isTutorialModalAttribute(
  attribute: string | null,
): attribute is TutorialModalAttribute {
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
  return isRenderableTutorialTargetWithRect(element, view, element.getBoundingClientRect());
}

function isRenderableTutorialTargetWithRect(
  element: HTMLElement,
  view: Window,
  rect: Pick<DOMRect, 'height' | 'width'>,
): boolean {
  if (!element.isConnected || rect.width <= 0 || rect.height <= 0) {
    return false;
  }

  let current: HTMLElement | null = element;

  while (current !== null) {
    const style = view.getComputedStyle(current);

    if (style.display === 'none'
      || style.visibility === 'hidden'
      || Number.parseFloat(style.opacity || '1') <= 0) {
      return false;
    }

    current = getComposedParentElement(current);
  }

  return true;
}

function isEligibleUnderlyingTutorialModal(element: HTMLElement, view: Window): boolean {
  return isEligibleTutorialTarget(element, view);
}

function isEligibleTutorialTarget(element: HTMLElement, view: Window): boolean {
  return isRenderableTutorialTarget(element, view)
    && isSemanticallyActiveTutorialElement(element);
}

function isEligibleTutorialTargetWithRect(
  element: HTMLElement,
  view: Window,
  rect: TutorialTargetRect,
): boolean {
  return isRenderableTutorialTargetWithRect(element, view, rect)
    && isSemanticallyActiveTutorialElement(element);
}

function isActivatableTutorialTarget(
  element: HTMLElement,
  view: Window | null = element.ownerDocument.defaultView,
): boolean {
  if (view === null
    || view.getComputedStyle(element).pointerEvents === 'none'
    || element.matches(':disabled')) {
    return false;
  }

  let current: HTMLElement | null = element;

  while (current !== null) {
    if (current.getAttribute('aria-disabled')?.toLowerCase() === 'true') {
      return false;
    }

    current = getComposedParentElement(current);
  }

  return true;
}

function isSemanticallyActiveTutorialElement(element: HTMLElement): boolean {
  let current: HTMLElement | null = element;

  while (current !== null) {
    if (current.getAttribute('aria-hidden')?.toLowerCase() === 'true'
      || current.inert
      || current.hasAttribute('inert')) {
      return false;
    }

    current = getComposedParentElement(current);
  }

  return true;
}

function getComposedParentElement(element: Element): HTMLElement | null {
  if (element.assignedSlot !== null) {
    return element.assignedSlot;
  }

  if (element.parentElement !== null) {
    return element.parentElement;
  }

  const root = element.getRootNode();
  return root instanceof ShadowRoot && root.host instanceof HTMLElement ? root.host : null;
}

function isComposedAncestorOrSelf(element: Element, candidateAncestor: Element): boolean {
  let current: Element | null = element;

  while (current !== null) {
    if (current === candidateAncestor) {
      return true;
    }

    current = getComposedParentElement(current);
  }

  return false;
}

function composedElementUsesTreeScope(element: Element, treeScope: Node): boolean {
  let current: Element | null = element;

  while (current !== null) {
    if (current.getRootNode() === treeScope) {
      return true;
    }

    current = getComposedParentElement(current);
  }

  return false;
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
  const element = target instanceof Element ? target : target.parentElement;

  if (element === null) {
    return false;
  }

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
