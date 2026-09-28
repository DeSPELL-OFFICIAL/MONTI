/**
 * The four tab roots — the only screens that get the bottom tab bar and, by the same token, the
 * only ones that are *not* a stack screen. Both the router (which draws the tabs) and `Screen`
 * (which draws the global back bar on everything else) read this one list, so the two can never
 * drift into disagreeing about what counts as a root.
 *
 * It lives in its own module rather than in `router.tsx` on purpose: `Screen` is imported by
 * `router.tsx` (through `shared/ui`), so importing the list back out of `router.tsx` would close
 * a cycle that pulls the whole route table into every screen. A two-line constants module has no
 * such gravity.
 */
export const TAB_PATHS = ['/', '/tickets', '/chats', '/me'];

/** True when `pathname` is a tab root, i.e. a screen that must not show the back bar. */
export function isTabRoot(pathname: string): boolean {
  return TAB_PATHS.includes(pathname);
}
