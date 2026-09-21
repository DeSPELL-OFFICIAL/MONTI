import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter, Navigate, Route, Routes } from 'react-router-dom';

import { Phone } from './attendee/signup/Phone';
import { Verify } from './attendee/signup/Verify';
import { initI18n } from './shared/i18n';
import { StaffRoutes } from './staff/StaffRoutes';

// The staff APK is a single-purpose kiosk: it boots straight into the gate console and has no
// address bar to type a different path into. MemoryRouter rather than BrowserRouter because a
// WebView reload must not be able to land anywhere else.
const root = document.getElementById('root');
if (!root) throw new Error('#root missing from staff.html');

/**
 * 스태프도 **전화번호로 로그인한다**. 게이트 등록 신청(`submitPendingGate`)은 Firebase uid 하나만
 * 요구하므로 관객 가입의 전화 단계 두 화면을 그대로 빌려 쓴다 — 스태프 전용 로그인 화면을 따로
 * 만들면 같은 reCAPTCHA·OTP 흐름이 두 벌이 된다.
 *
 * 그 흐름이 관객 전용 다음 단계(`/signup/passkey`, `/login`)로 넘어가려 하면 여기서 잡아 설치
 * 화면으로 돌려보낸다. 그 시점에는 전화 세션이 이미 있고, 게이트에 필요한 건 그게 전부다.
 */
void initI18n().then(() => {
  createRoot(root).render(
    <StrictMode>
      <MemoryRouter initialEntries={['/staff/setup']}>
        <Routes>
          <Route path="/staff/*" element={<StaffRoutes />} />
          <Route path="/signup/phone" element={<Phone />} />
          <Route path="/signup/verify" element={<Verify />} />
          <Route path="*" element={<Navigate to="/staff/setup" replace />} />
        </Routes>
      </MemoryRouter>
    </StrictMode>,
  );
});
