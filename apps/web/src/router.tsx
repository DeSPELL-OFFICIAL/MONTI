import { useContext, useRef, type ReactNode } from 'react';
import {
  Navigate,
  Outlet,
  type RouteObject,
  UNSAFE_LocationContext as LocationContext,
  useLocation,
  useOutlet,
} from 'react-router-dom';
import { BottomTabs } from './shared/ui';
import { useRegistration } from './shared/registration';
import { useDeviceHealth } from './shared/deviceHealth';
import { useSession } from './shared/session';
import { Spinner } from './shared/ui';
import { AnimatePresence, m, useIsPresent, useReducedMotion } from './shared/motion';
import { TAB_PATHS } from './shared/tabRoots';
import { authMode } from './shared/config';

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
/**
 * A screen sliding out is still mounted, and without this it would keep reading the LIVE location
 * — the one the router has already moved on to. Every location-driven effect in it then re-runs
 * against the new URL: `/start` lost its `?returnTo=` and navigated to `/` right after sending the
 * visitor to their shared link, and the guards redirected the screen being entered to itself.
 * While present the screen sees the live location; once exiting it keeps the last one it saw, the
 * same "frozen router" an exiting route gets in any animated-routes setup.
 */
function FreezeLocationWhenExiting({ children }: { children: ReactNode }) {
  const present = useIsPresent();
  const live = useContext(LocationContext);
  const seen = useRef(live);
  if (present) seen.current = live;
  return <LocationContext.Provider value={seen.current}>{children}</LocationContext.Provider>;
}

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
            <FreezeLocationWhenExiting>{outlet}</FreezeLocationWhenExiting>
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
    // Open mode has no sign-in screen: the one-tap start is where an identity comes from.
    const entry = authMode() === 'open' ? '/start' : '/login';
    // Where they were going rides along, so a claim link opened signed out comes back to the
    // claim after sign-in or signup rather than landing on 내 티켓.
    const returnTo = encodeURIComponent(`${location.pathname}${location.search}`);
    return <Navigate to={`${entry}?returnTo=${returnTo}`} replace />;
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
    const finishAt = authMode() === 'open' ? '/start' : '/signup/register';
    const returnTo = encodeURIComponent(`${location.pathname}${location.search}`);
    return <Navigate to={`${finishAt}?returnTo=${returnTo}`} replace />;
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

/**
 * The phone-mode entry screens (`/login`, `/signup/phone|verify|register`). In open mode
 * (`VITE_AUTH_MODE=open`) none of them can be finished — there is no phone and no passkey — so each
 * forwards to `/start`, carrying the query so a `returnTo` still brings the visitor back.
 */
function PhoneModeOnly({ children }: { children: ReactNode }) {
  const { search } = useLocation();
  if (authMode() === 'open') return <Navigate to={`/start${search}`} replace />;
  return <>{children}</>;
}

/** `/recover`: an SMS check in phone mode, a fresh start on this browser in open mode. */
function RecoverByMode() {
  return authMode() === 'open' ? <RecoverOpen /> : <Recover />;
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
import { Start } from './attendee/start/Start';
import { RecoverOpen } from './attendee/start/RecoverOpen';
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
      { path: '/login', element: <PhoneModeOnly><Login /></PhoneModeOnly> },
      // Open mode's one-tap identity (VITE_AUTH_MODE=open). Public: it is where identities start.
      { path: '/start', element: <Start /> },
      { path: '/signup/phone', element: <PhoneModeOnly><Phone /></PhoneModeOnly> },
      { path: '/signup/verify', element: <PhoneModeOnly><Verify /></PhoneModeOnly> },
      { path: '/signup/register', element: <PhoneModeOnly><Register /></PhoneModeOnly> },
      { path: '/signup/passkey', element: <ToRegister /> },
      { path: '/signup/device', element: <ToRegister /> },
      { path: '/signup/done', element: <Done /> },
      // Public on purpose: recovery runs on a fresh phone that has only a phone session, not a
      // passkey session, so it must sit outside RequireSession next to the other signup screens.
      { path: '/recover', element: <RecoverByMode /> },
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
