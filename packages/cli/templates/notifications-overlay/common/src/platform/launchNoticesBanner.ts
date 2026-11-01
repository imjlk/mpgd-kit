import {
  createStarterNoticeVisibility,
  starterNotificationLabelsFor,
  type StarterLaunchNotices,
} from './notificationSettings';

/**
 * The launch notices (`showStarterLaunchNotices`) as a small box at the top
 * of the page, over the game: a heading, each notice, and a close button.
 * It takes no focus and pauses nothing; only its own area takes taps, and the
 * game goes on under and around it. `onSeen` runs once for each notice the
 * player can see: on screen, not scrolled out of the box, while the page is
 * visible (`createStarterNoticeVisibility`), so a notice is recorded only
 * once it was seen. Returns the disposer, which closing the box also runs.
 */
export function mountStarterLaunchNotices(
  notices: StarterLaunchNotices['notices'],
  locale: string,
  options: {
    readonly onSeen: (index: number) => void;
    readonly parent?: HTMLElement;
  },
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
  const visibility = createStarterNoticeVisibility({
    pageVisible: () => document.visibilityState === 'visible',
    onSeen: options.onSeen,
  });
  const paragraphs = notices.map((notice, index) => {
    const paragraph = document.createElement('p');
    paragraph.style.whiteSpace = 'pre-line';
    paragraph.textContent = `${notice.title}\n${notice.body}`;
    paragraph.dataset['noticeIndex'] = String(index);
    box.append(paragraph);
    return paragraph;
  });
  const close = document.createElement('button');
  close.type = 'button';
  close.textContent = text.close;
  box.append(close);
  // A notice counts as seen once most of it shows in the box (its scroll
  // area, which stays on screen), or, for one taller than the box, once it
  // fills most of the box. Without IntersectionObserver every notice counts
  // as on screen, so it is seen while the page is visible.
  const observer = typeof IntersectionObserver === 'function'
    ? new IntersectionObserver((entries) => {
        for (const entry of entries) {
          const index = Number((entry.target as HTMLElement).dataset['noticeIndex']);
          const shown = entry.intersectionRect.height;
          const area = entry.rootBounds?.height ?? 0;
          visibility.intersecting(
            index,
            entry.isIntersecting && (entry.intersectionRatio >= 0.6 || (area > 0 && shown >= area * 0.6)),
          );
        }
      }, { root: box, threshold: Array.from({ length: 21 }, (_, step) => step / 20) })
    : undefined;
  const onVisibilityChange = (): void => visibility.pageVisibilityChanged();
  document.addEventListener('visibilitychange', onVisibilityChange);
  (options.parent ?? document.body).append(box);
  if (observer === undefined) {
    paragraphs.forEach((_paragraph, index) => visibility.intersecting(index, true));
  } else {
    for (const paragraph of paragraphs) {
      observer.observe(paragraph);
    }
  }
  let disposed = false;
  const dispose = (): void => {
    if (disposed) {
      return;
    }
    disposed = true;
    observer?.disconnect();
    document.removeEventListener('visibilitychange', onVisibilityChange);
    box.remove();
  };
  close.addEventListener('click', dispose);
  return dispose;
}
