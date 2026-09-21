import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

import { StaffRoutes } from './staff/StaffRoutes';

// The staff APK is a single-purpose kiosk: it boots straight into the gate console and has no
// address bar to type a different path into. MemoryRouter rather than BrowserRouter because a
// WebView reload must not be able to land anywhere else.
const root = document.getElementById('root');
if (!root) throw new Error('#root missing from staff.html');

createRoot(root).render(
  <StrictMode>
    <MemoryRouter initialEntries={['/staff/setup']}>
      <Routes>
        <Route path="/staff/*" element={<StaffRoutes />} />
      </Routes>
    </MemoryRouter>
  </StrictMode>,
);
