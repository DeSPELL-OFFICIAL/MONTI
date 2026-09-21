import { Navigate, Outlet, type RouteObject, useLocation } from 'react-router-dom';
import { BottomTabs } from './shared/ui';
import { useSession } from './shared/session';
import { Spinner } from './shared/ui';

const TAB_PATHS = ['/', '/tickets', '/chats', '/me'];

function TabShell() {
  const location = useLocation();
  const showTabs = TAB_PATHS.includes(location.pathname);
  return (
    <>
      <Outlet />
      {showTabs ? <BottomTabs /> : null}
    </>
  );
}

export function RequireSession() {
  const session = useSession();
  if (session.status === 'loading') return <Spinner />;
  if (session.status === 'anonymous') return <Navigate to="/login" replace />;
  return <Outlet />;
}

// 각 화면은 뒤 태스크에서 실제 구현으로 교체된다. 여기서는 라우트 표를 확정한다.
import { Discover } from './attendee/discover/Discover';
import { EventDetail } from './attendee/discover/EventDetail';
import { Login } from './attendee/Login';
import { Phone } from './attendee/signup/Phone';
import { Verify } from './attendee/signup/Verify';
import { VerifyIdentity } from './attendee/me/VerifyIdentity';
import { PasskeyStep } from './attendee/signup/Passkey';
import { DeviceStep } from './attendee/signup/Device';
import { Done } from './attendee/signup/Done';
import { Claim } from './attendee/claim/Claim';
import { TicketList } from './attendee/tickets/List';
import { TicketDetail } from './attendee/tickets/Detail';
import { TransferRecipient } from './attendee/transfer/Recipient';
import { TransferConfirm } from './attendee/transfer/Confirm';
import { Enter } from './attendee/enter/Enter';
import { ChatList } from './attendee/chats/ChatList';
import { ChatRoom } from './attendee/chats/ChatRoom';
import { Profile } from './attendee/me/Profile';
import { OrganizerRoutes } from './organizer/Layout';
import { StaffRoutes } from './staff/Console';

export const routes: RouteObject[] = [
  {
    element: <TabShell />,
    children: [
      { path: '/', element: <Discover /> },
      { path: '/events/:eventId', element: <EventDetail /> },
      { path: '/login', element: <Login /> },
      { path: '/signup/phone', element: <Phone /> },
      { path: '/signup/verify', element: <Verify /> },
      { path: '/signup/passkey', element: <PasskeyStep /> },
      { path: '/signup/device', element: <DeviceStep /> },
      { path: '/signup/done', element: <Done /> },
      {
        element: <RequireSession />,
        children: [
          { path: '/claim/:eventId', element: <Claim /> },
          { path: '/tickets', element: <TicketList /> },
          { path: '/tickets/:tokenId', element: <TicketDetail /> },
          { path: '/tickets/:tokenId/transfer', element: <TransferRecipient /> },
          { path: '/tickets/:tokenId/transfer/confirm', element: <TransferConfirm /> },
          { path: '/tickets/:tokenId/enter', element: <Enter /> },
          { path: '/chats', element: <ChatList /> },
          { path: '/chats/:eventId', element: <ChatRoom /> },
          { path: '/me', element: <Profile /> },
          { path: '/me/verify', element: <VerifyIdentity /> },
          { path: '/org/*', element: <OrganizerRoutes /> },
        ],
      },
      { path: '/staff/*', element: <StaffRoutes /> },
      { path: '*', element: <Navigate to="/" replace /> },
    ],
  },
];
