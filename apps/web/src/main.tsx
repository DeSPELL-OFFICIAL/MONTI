import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { initI18n } from './shared/i18n';

const rootElement = document.getElementById('root');
if (!rootElement) throw new Error('#root not found');

void initI18n().then(() => {
  createRoot(rootElement).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
});
