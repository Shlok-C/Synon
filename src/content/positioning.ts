function computePosition(rect: DOMRect): { left: number; top: number } {
  const MARGIN = 8;
  const GAP = 6;
  const POPUP_HEIGHT_EST = 160;
  const POPUP_WIDTH_EST = 360;

  let top = rect.bottom + GAP;
  let left = rect.left;

  if (top + POPUP_HEIGHT_EST > window.innerHeight - MARGIN) {
    top = rect.top - GAP - POPUP_HEIGHT_EST;
  }

  if (top < MARGIN) {
    top = MARGIN;
  }

  if (left + POPUP_WIDTH_EST > window.innerWidth - MARGIN) {
    left = window.innerWidth - MARGIN - POPUP_WIDTH_EST;
  }
  if (left < MARGIN) {
    left = MARGIN;
  }

  return { left, top };
}

function isRectInViewport(rect: DOMRect): boolean {
  return (
    rect.bottom > 0 &&
    rect.top < window.innerHeight &&
    rect.right > 0 &&
    rect.left < window.innerWidth &&
    rect.width > 0 &&
    rect.height > 0
  );
}

export interface PositionTracker {
  attach(card: HTMLDivElement, range: Range): void;
  detach(): void;
  computeInitialPosition(rect: DOMRect): { left: number; top: number };
}

export function createPositionTracker(): PositionTracker {
  let currentCard: HTMLDivElement | null = null;
  let currentRange: Range | null = null;
  let trackingRafId: number | null = null;

  function updatePopupPosition(): void {
    if (!currentCard || !currentRange) return;

    const rect = currentRange.getBoundingClientRect();

    if (!isRectInViewport(rect)) {
      currentCard.style.visibility = "hidden";
      return;
    }

    currentCard.style.visibility = "visible";
    const { left, top } = computePosition(rect);
    currentCard.style.left = `${left}px`;
    currentCard.style.top = `${top}px`;
  }

  function onScrollOrResize(): void {
    if (trackingRafId !== null) return;
    trackingRafId = requestAnimationFrame(() => {
      trackingRafId = null;
      updatePopupPosition();
    });
  }

  return {
    attach(card: HTMLDivElement, range: Range): void {
      currentCard = card;
      currentRange = range;
      document.addEventListener("scroll", onScrollOrResize, true);
      window.addEventListener("resize", onScrollOrResize);
    },

    detach(): void {
      if (trackingRafId !== null) {
        cancelAnimationFrame(trackingRafId);
        trackingRafId = null;
      }
      document.removeEventListener("scroll", onScrollOrResize, true);
      window.removeEventListener("resize", onScrollOrResize);
      currentCard = null;
      currentRange = null;
    },

    computeInitialPosition: computePosition,
  };
}
