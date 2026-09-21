import { Navigate, Route, Routes } from 'react-router-dom';

import { GateSetupScreen } from './setup/GateSetupScreen';

/**
 * The staff console's route table. It is a descendant router: the attendee build mounts it at
 * `/staff/*` and the staff APK boots a MemoryRouter straight into `/staff/setup`, so every
 * path below is relative and there is exactly one copy of this table.
 *
 * Setup is the entry point rather than a step that can be skipped. A device that is not yet a
 * registered gate has nothing else it can do, and one that is registered comes back here on
 * every cold start to be told so by the chain (`gateOf`) rather than by anything it stored.
 */
export function StaffRoutes() {
  return (
    <Routes>
      <Route path="setup" element={<GateSetupScreen />} />
      <Route path="*" element={<Navigate to="setup" replace />} />
    </Routes>
  );
}
