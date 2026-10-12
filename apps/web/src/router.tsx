import { Navigate, Outlet, type RouteObject, useLocation, useOutlet } from 'react-router-dom';
import { BottomTabs } from './shared/ui';
import { useRegistration } from './shared/registration';
import { useDeviceHealth } from './shared/deviceHealth';
import { useSession } from './shared/session';
import { Spinner } from './shared/ui';
import { AnimatePresence, m, useReducedMotion } from './shared/motion';
import { TAB_PATHS } from './shared/tabRoots';

/**
 * The screen slides in from the right and the one it replaces slides out to the left — 240ms of
 * transform and opacity, nothing that reflows. `mode="wait"` keeps the two from overlapping, so
 * only one screen is ever laid out; keying on the path is what tells `AnimatePresence` a screen
 * has actually changed. `body` already has `overflow-x: hidden`, so the 24px the entering screen
 * starts offset by never becomes a horizontal scrollbar.
 *
 * Under reduced motion the whole apparatus is skipped: the outlet is rendered straight, with no
 * wrapper and no transform, so a person who asked for stillness gets an instant cut. The tab bar
 * lives outside the animated region on purpose — it is chrome, not a screen, and must not slide
 * with the content under it (and, being outside the transformed element, keeps its fixed
 * position anchored to the viewport).
 */
function TabShell() {
  const location = useLocation();
  const outlet = useOutlet();
  const reduce = useReducedMotion();
  const showTabs = TAB_PATHS.includes(location.pathname);
  return (
    <>
      {reduce ? (
        outlet
      ) : (
        <AnimatePresence mode="wait" initial={false}>
          <m.div
            key={location.pathname}
            className="route-view"
            initial={{ opacity: 0, x: 24 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: -24 }}
            transition={{ duration: 0.24, ease: [0.22, 0.61, 0.36, 1] }}
          >
            {outlet}
          </m.div>
        </AnimatePresence>
      )}
      {showTabs ? <BottomTabs /> : null}
    </>
  );
}

export function RequireSession() {
  const session = useSession();
  const location = useLocation();
  if (session.status === 'loading') return <Spinner />;
  if (session.status === 'anonymous') {
    // The route transition keeps this (exiting) screen mounted for its slide-out, and it then reads
    // the new location: without this it would bounce `/login` to itself and nest the target.
    if (location.pathname === '/login') return null;
    // Where they were going rides along, so a claim link opened signed out comes back to the
    // claim after sign-in or signup rather than landing on 내 티켓.
    const returnTo = encodeURIComponent(`${location.pathname}${location.search}`);
    return <Navigate to={`/login?returnTo=${returnTo}`} replace />;
  }
  return <FinishSignupFirst />;
}

/**
 * The one place that knows a signed-in person may still be `pending`. It sits here rather than
 * on each screen because the answer is the same everywhere: a person whose chain registration
 * never happened is refused by `startKyc` and by every claim, and the fix is one screen away.
 *
 * Only `pending` redirects. `unknown` and `checking` render the screen the person asked for —
 * an unanswered question is not grounds for interrupting anybody. Where they were going travels
 * in `returnTo` so the device screen can put them back.
 */
function FinishSignupFirst() {
  const registration = useRegistration();
  const location = useLocation();
  if (registration === 'pending') {
    const returnTo = encodeURIComponent(`${location.pathname}${location.search}`);
    return <Navigate to={`/signup/register?returnTo=${returnTo}`} replace />;
  }
  return <HealthyDeviceFirst registrationDone={registration === 'done'} />;
}

/**
 * The second guard, after signup is known finished: is the device key on this browser one the
 * chain will accept? A passkey syncs across a person's browsers; the device key does not, so a
 * synced-passkey login can land on a browser with no usable device key — and without this the
 * person only finds out at a claim or a door (`BadDeviceSignature`). `/recover` re-issues the key
 * after a fresh phone check (`recoverAccess`), and until then the 내 티켓 actions behind this guard
 * stay out of reach.
 *
 * Gated on `registrationDone`: the check reads `Identity.activeDevice`, which is zero for a person
 * who never finished chain registration, and that person belongs in signup (handled above), not in
 * recovery. `needs-recovery` is the only state that redirects; `unknown` (chain unreachable, or a
 * native device) never interrupts anyone.
 */
function HealthyDeviceFirst({ registrationDone }: { registrationDone: boolean }) {
  const health = useDeviceHealth(registrationDone);
  if (health === 'needs-recovery') return <Navigate to="/recover" replace />;
  return <Outlet />;
}

/**
 * The two screens `/signup/register` replaced. Links to them are already in the wild — an old
 * tab, a text somebody sent themselves — and the query travels with them, because `returnTo` is
 * what tells the register screen this is an account being finished rather than a fresh signup.
 */
function ToRegister() {
  const { search } = useLocation();
  return <Navigate to={`/signup/register${search}`} replace />;
}

// 각 화면은 뒤 태스크에서 실제 구현으로 교체된다. 여기서는 라우트 표를 확정한다.
import { Discover } from './attendee/discover/Discover';
import { EventDetail } from './attendee/discover/EventDetail';
import { Login } from './attendee/Login';
import { Phone } from './attendee/signup/Phone';
import { Verify } from './attendee/signup/Verify';
import { VerifyIdentity } from './attendee/me/VerifyIdentity';
import { KycCallback } from './attendee/me/KycCallback';
import { Register } from './attendee/signup/Register';
import { Recover } from './attendee/signup/Recover';
import { Done } from './attendee/signup/Done';
import { Claim } from './attendee/claim/Claim';
import { TicketList } from './attendee/tickets/List';
import { TicketDetail } from './attendee/tickets/Detail';
import { TransferRecipient } from './attendee/transfer/Recipient';
import { TransferConfirm } from './attendee/transfer/Confirm';
import { TransferInvite } from './attendee/transfer/Invite';
import { InviteLanding } from './attendee/transfer/InviteLanding';
import { Inbox } from './attendee/tickets/Inbox';
import { Enter } from './attendee/enter/Enter';
import { TicketGate } from './attendee/tickets/TicketGate';
import { ChatList } from './attendee/chats/ChatList';
import { ChatRoom } from './attendee/chats/ChatRoom';
import { Profile } from './attendee/me/Profile';
import { OrganizerRoutes } from './organizer/Layout';
import { StaffRoutes } from './staff/StaffRoutes';
import { Settlement } from './public/settlement/Settlement';

export const routes: RouteObject[] = [
  {
    element: <TabShell />,
    children: [
      { path: '/', element: <Discover /> },
      { path: '/events/:eventId', element: <EventDetail /> },
      // Public on purpose: a shareable, no-login record of how one event's revenue is split.
      { path: '/settlement/:eventId', element: <Settlement /> },
      { path: '/login', element: <Login /> },
      { path: '/signup/phone', element: <Phone /> },
      { path: '/signup/verify', element: <Verify /> },
      { path: '/signup/register', element: <Register /> },
      { path: '/signup/passkey', element: <ToRegister /> },
      { path: '/signup/device', element: <ToRegister /> },
      { path: '/signup/done', element: <Done /> },
      // Public on purpose: recovery runs on a fresh phone that has only a phone session, not a
      // passkey session, so it must sit outside RequireSession next to the other signup screens.
      { path: '/recover', element: <Recover /> },
      // Where the link in an invite text lands. Public on purpose: the person it was sent to
      // is usually not signed in yet, and this screen is what starts their signup.
      { path: '/i/:inviteId', element: <InviteLanding /> },
      // Public on purpose: the hosted identity check returns a browser here, and a person whose
      // session dropped while they were away must still be forwarded rather than bounced home.
      { path: '/kyc/callback', element: <KycCallback /> },
      {
        element: <RequireSession />,
        children: [
          { path: '/claim/:eventId', element: <Claim /> },
          { path: '/tickets', element: <TicketList /> },
          { path: '/tickets/inbox', element: <Inbox /> },
          { path: '/tickets/:tokenId', element: <TicketDetail /> },
          { path: '/tickets/:tokenId/transfer', element: <TicketGate need="transfer"><TransferRecipient /></TicketGate> },
          { path: '/tickets/:tokenId/transfer/confirm', element: <TransferConfirm /> },
          { path: '/tickets/:tokenId/transfer/invite', element: <TransferInvite /> },
          // The detail hides these two for a refunded/used/cancelled ticket; the routes ask again.
          { path: '/tickets/:tokenId/enter', element: <TicketGate need="enter"><Enter /></TicketGate> },
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
