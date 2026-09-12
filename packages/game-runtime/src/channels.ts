export const executionChannels = Object.freeze([
  'simulation', 'gameplay-input', 'rendering', 'audio',
] as const);

export type ExecutionChannel = (typeof executionChannels)[number];
