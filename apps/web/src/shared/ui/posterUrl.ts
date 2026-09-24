import { gatewayUrl } from '../envio/ipfs';

/**
 * The object URL of every picture this session pinned, against the CID the server gave back.
 *
 * It exists to stop one specific piece of waste. The poster is cropped in the browser, so the
 * bytes are already in memory; asking a public IPFS gateway for them again the moment the pin
 * returns downloads what the organiser is looking at (plan section D-2, suspect 2) and adds
 * the gateway's own propagation delay to a screen that had nothing left to wait for.
 *
 * Module scope rather than a context because it outlives the scene: the done screen is a
 * different route, mounted after the creation scene is gone, and it shows the same poster.
 * A reload empties it, which is right — those bytes are genuinely no longer here.
 */
const local = new Map<string, string>();

/** Keeps the bytes behind `url` reachable under `cid` for the rest of the session. */
export function rememberPoster(cid: string, url: string): void {
  if (cid !== '') local.set(cid, url);
}

/** The local bytes when this session is the one that uploaded them, the gateway otherwise. */
export function posterUrl(cid: string): string {
  return local.get(cid) ?? gatewayUrl(cid);
}
