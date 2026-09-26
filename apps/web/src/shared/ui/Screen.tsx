import type { ReactNode } from 'react';
import { useInRouterContext, useLocation, useNavigate } from 'react-router-dom';
import { isTabRoot } from '../tabRoots';
import { useCopy } from '../i18n';

export function Screen({ title, children }: { title?: string; children: ReactNode }) {
  // The whole app runs under one router, so in the product this is always true and the back bar is
  // always considered. It is only ever false when a screen is mounted on its own in a unit test —
  // there is no route there to go back from, so the chrome simply stays off.
  const inRouter = useInRouterContext();
  return (
    <main className="screen">
      {inRouter ? <BackBar /> : null}
      {title ? <h1>{title}</h1> : null}
      {children}
    </main>
  );
}

/**
 * The one back control the whole app shares. It draws on every screen that is not a tab root — a
 * tab root has the bottom tab bar as its way around, everything else is a stack screen that, in a
 * PWA or webview with no browser chrome, would otherwise be a dead end.
 */
function BackBar() {
  const location = useLocation();
  const navigate = useNavigate();
  const copy = useCopy();
  if (isTabRoot(location.pathname)) return null;

  // `location.key` is `'default'` only for the very first entry the app ever put on the stack — a
  // link opened cold, an NFC tag scanned into a fresh tab. There is nothing to pop, so we send the
  // person home rather than out of the app (or nowhere at all).
  function goBack() {
    if (location.key === 'default') navigate('/');
    else navigate(-1);
  }

  return (
    <div className="app-bar">
      <button type="button" className="app-bar__back" aria-label={copy.common.back} onClick={goBack}>
        <span aria-hidden="true">‹</span>
      </button>
    </div>
  );
}
