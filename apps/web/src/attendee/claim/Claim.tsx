import { useParams } from 'react-router-dom';
import { ClaimFlow } from './ClaimFlow';

/**
 * The `/claim/:id` route. Since the claim was absorbed into the event-detail inline sheet (plan
 * B1), this route is the deep-link and refresh-return entry only: an invite → claim resume lands
 * here, and the identity check returns here. It renders the very same {@link ClaimFlow} engine the
 * detail sheet does — the state machine is factored into one place, never copied.
 */
export function Claim() {
  const { eventId = '' } = useParams();
  return <ClaimFlow eventId={eventId} present={{ kind: 'screen' }} />;
}
