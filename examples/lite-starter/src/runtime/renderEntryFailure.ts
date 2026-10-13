export function renderEntryFailure(error: unknown): void {
  console.error('[entry] Failed to load the game module.', error);

  const root = document.querySelector<HTMLElement>('#game');

  if (root === null) {
    return;
  }

  root.replaceChildren();
  const panel = document.createElement('div');
  panel.setAttribute('role', 'alert');
  panel.textContent = 'Failed to load the game. Please refresh and try again.';
  panel.style.boxSizing = 'border-box';
  panel.style.width = 'min(720px, calc(100% - 32px))';
  panel.style.margin = '20dvh auto 0';
  panel.style.padding = '20px';
  panel.style.border = '1px solid #dc2626';
  panel.style.borderRadius = '8px';
  panel.style.background = '#1f1111';
  panel.style.color = '#fecaca';
  panel.style.font = '16px/1.5 Arial, sans-serif';
  root.append(panel);
}
