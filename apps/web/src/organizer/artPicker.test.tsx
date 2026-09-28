import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

// The picker owns the upload; the pin and the crop are somebody else's job, mocked here so the
// test is about the carousel and the callback, not about IPFS.
const pin = vi.fn(async () => 'bafknew');
vi.mock('./scene/usePinImage', () => ({
  usePinImage: () => ({ pin, busy: false, problem: '' }),
}));

vi.mock('../shared/ui/a4Crop', async (orig) => ({
  ...(await orig<typeof import('../shared/ui/a4Crop')>()),
  cropToA4: vi.fn(async () => ({ blob: new Blob(), base64: 'AQID', width: 1240, height: 1754 })),
}));

const { ArtPicker } = await import('./ArtPicker');
const { organizerCopy } = await import('./copy');
const { ko: sharedCopy } = await import('../shared/copy/index');
const { TICKET_ART_PRESETS } = await import('./scene/draftRules');

const copy = organizerCopy.ko.scene.tiers;

/** Captures the observer the carousel makes, so a test can drive a scroll-snap centre by hand. */
class IOStub {
  static last: IOStub | null = null;
  readonly cb: IntersectionObserverCallback;
  readonly observed: Element[] = [];
  constructor(cb: IntersectionObserverCallback) {
    this.cb = cb;
    IOStub.last = this;
  }
  observe(el: Element): void { this.observed.push(el); }
  unobserve(): void {}
  disconnect(): void {}
  takeRecords(): IntersectionObserverEntry[] { return []; }
}

function fireCentre(container: HTMLElement, index: number): void {
  const tile = container.querySelector(`[data-tile-index="${index}"]`) as HTMLElement;
  act(() => {
    IOStub.last?.cb(
      [{ target: tile, isIntersecting: true, intersectionRatio: 1 } as unknown as IntersectionObserverEntry],
      IOStub.last as unknown as IntersectionObserver,
    );
  });
}

beforeAll(() => {
  URL.createObjectURL = () => 'blob:art';
  URL.revokeObjectURL = () => undefined;
});

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  IOStub.last = null;
});

type Props = Parameters<typeof ArtPicker>[0];

function setup(overrides: Partial<Props> = {}) {
  const onPreset = vi.fn();
  const onUploaded = vi.fn();
  const utils = render(
    <ArtPicker
      art={{ preset: 'a' }}
      title="재즈 나이트"
      tierName="일반"
      onPreset={onPreset}
      onUploaded={onUploaded}
      {...overrides}
    />,
  );
  return { onPreset, onUploaded, ...utils };
}

describe('the ticket art carousel', () => {
  it('draws a live preview and a caption for each of the twelve backdrops, plus a dot each', () => {
    const { container } = setup();
    for (const preset of TICKET_ART_PRESETS) {
      // The tile's accessible name is the preset — never the fifteen words of the drawing inside.
      expect(screen.getByRole('radio', { name: copy.artNames[preset] })).toBeInTheDocument();
    }
    expect(screen.getByRole('radio', { name: copy.artUpload })).toBeInTheDocument();
    expect(container.querySelectorAll('.art-tile__preview .ticket-art')).toHaveLength(12);
    expect(container.querySelectorAll('.art-dot')).toHaveLength(12);
  });

  it('selects the preset on a click and hands the caller the letter, never the name', async () => {
    const user = userEvent.setup();
    const { onPreset } = setup();
    await user.click(screen.getByRole('radio', { name: copy.artNames.c }));
    expect(onPreset).toHaveBeenCalledWith('c');
  });

  it('moves and selects with the arrow keys (roving tabindex)', async () => {
    const user = userEvent.setup();
    const { onPreset } = setup();
    screen.getByRole('radio', { name: copy.artNames.a }).focus();
    await user.keyboard('{ArrowRight}');
    expect(onPreset).toHaveBeenLastCalledWith('b');
    await user.keyboard('{End}');
    expect(onPreset).toHaveBeenLastCalledWith('l');
  });

  it('lights the dot of the centre tile on a scroll-snap but never selects it (expert-4 D5)', () => {
    vi.stubGlobal('IntersectionObserver', IOStub);
    const { container, onPreset } = setup();
    // Even after a real scroll, centring a tile only lights its dot — a browse must not pick.
    fireEvent.scroll(container.querySelector('.art-carousel') as HTMLElement);
    fireCentre(container, 2);
    expect(onPreset).not.toHaveBeenCalled();
    expect((container.querySelectorAll('.art-dot')[2] as HTMLElement).className).toContain('art-dot--on');
  });

  it('keeps the draft clean while scrolling over a picture of their own', () => {
    vi.stubGlobal('IntersectionObserver', IOStub);
    // A picture of their own is in place: scrolling past the presets must not clobber it.
    const { container, onPreset } = setup({ art: { imageCid: 'bafkkept' } });
    fireCentre(container, 2);
    fireCentre(container, 5);
    expect(onPreset).not.toHaveBeenCalled();
    // The dot still moves, so the row is not frozen — only the choice is withheld.
    expect((container.querySelectorAll('.art-dot')[5] as HTMLElement).className).toContain('art-dot--on');
  });

  it('is a radiogroup whose chosen tile is the checked radio', () => {
    setup({ art: { preset: 'c' } });
    expect(screen.getByRole('radiogroup', { name: copy.artCarousel })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: copy.artNames.c })).toBeChecked();
    expect(screen.getByRole('radio', { name: copy.artNames.a })).not.toBeChecked();
  });

  it('opens the same cropper on the last tile and reports a finished upload', async () => {
    const user = userEvent.setup();
    const { onUploaded } = setup();
    await user.click(screen.getByRole('radio', { name: copy.artUpload }));
    const file = new File([new Uint8Array([1, 2, 3])], 'art.jpg', { type: 'image/jpeg' });
    await user.upload(screen.getByLabelText(sharedCopy.poster.pick), file);
    await user.click(await screen.findByRole('button', { name: sharedCopy.poster.crop }));
    expect(pin).toHaveBeenCalled();
    await waitFor(() => expect(onUploaded).toHaveBeenCalledWith('bafknew'));
  });
});
