export * from './definition.js';
export * from './director.js';
export * from './progress.js';

export const tutorialDomAttributes = Object.freeze({
  active: 'data-mpgd-tutorial-active',
  next: 'data-mpgd-tutorial-next',
  popover: 'data-mpgd-tutorial-popover',
  skip: 'data-mpgd-tutorial-skip',
  step: 'data-mpgd-tutorial-step',
  target: 'data-mpgd-tutorial-target',
});

export const tutorialDomSelectors = Object.freeze({
  active: '[data-mpgd-tutorial-active="true"]',
  next: '[data-mpgd-tutorial-next]',
  popover: '[data-mpgd-tutorial-popover]',
  skip: '[data-mpgd-tutorial-skip]',
  target: '[data-mpgd-tutorial-target]',
});
