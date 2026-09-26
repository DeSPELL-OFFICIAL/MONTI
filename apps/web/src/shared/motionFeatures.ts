/**
 * The motion feature bundle, in a module of its own so it can be split out of the main entry.
 *
 * `MotionProvider` loads this through a dynamic `import()`, which makes this the *only* path that
 * reaches `domMax`. Rollup can therefore place `domMax` — drag, layout projection and the rest of
 * the gesture/animation features, ~46 kB gz — in a chunk of its own that arrives just after the
 * first paint, rather than folding it into the main bundle every screen has to download first.
 *
 * `domMax` and not `domAnimation`: the ticket sheet's drag-to-dismiss needs pan/drag and the tab
 * indicator needs shared layout (`layoutId`); `domAnimation` ships neither, so it would force a
 * second, larger feature load the moment either lands. This is the whole feature set, loaded once.
 */
export { domMax as default } from 'motion/react';
