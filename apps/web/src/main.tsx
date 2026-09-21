import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { initI18n } from './shared/i18n';
import { installSessionHydrator } from './shared/api/sessionHydrator';

const rootElement = document.getElementById('root');
if (!rootElement) throw new Error('#root not found');

// session.ts learns about Firebase only here, and only before <App/> boots the session.
installSessionHydrator();

void initI18n().then(() => {
  createRoot(rootElement).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
});
