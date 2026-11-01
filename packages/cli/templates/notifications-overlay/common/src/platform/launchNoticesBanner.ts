import { starterNotificationLabelsFor, type StarterLaunchNotices } from './notificationSettings';

/**
 * The launch notices (`showStarterLaunchNotices`) as a small box at the top
 * of the page, over the game: a heading, each notice, and a close button.
 * It takes no focus and pauses nothing; only its own area takes taps, and the
 * game goes on under and around it. Returns the disposer, which closing the
 * box also runs.
 */
export function mountStarterLaunchNotices(
  notices: StarterLaunchNotices['notices'],
  locale: string,
  parent: HTMLElement = document.body,
): () => void {
  const text = starterNotificationLabelsFor(locale);
  const box = document.createElement('div');
  box.setAttribute('role', 'status');
  box.setAttribute('aria-label', text.notices);
  Object.assign(box.style, {
    position: 'fixed',
    top: '12px',
    left: '50%',
    transform: 'translateX(-50%)',
    width: 'min(560px, calc(100% - 32px))',
    maxHeight: '50vh',
    overflowY: 'auto',
    boxSizing: 'border-box',
    padding: '12px 16px',
    borderRadius: '8px',
    background: 'rgba(15, 23, 42, 0.94)',
    color: '#d6dee8',
    font: '14px Arial, sans-serif',
    zIndex: '1000',
  });
  const heading = document.createElement('strong');
  heading.textContent = text.notices;
  box.append(heading);
  for (const notice of notices) {
    const paragraph = document.createElement('p');
    paragraph.style.whiteSpace = 'pre-line';
    paragraph.textContent = `${notice.title}\n${notice.body}`;
    box.append(paragraph);
  }
  const close = document.createElement('button');
  close.type = 'button';
  close.textContent = text.close;
  const dispose = (): void => {
    box.remove();
  };
  close.addEventListener('click', dispose);
  box.append(close);
  parent.append(box);
  return dispose;
}
