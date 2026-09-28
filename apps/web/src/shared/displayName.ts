import { useEffect, useState } from 'react';
import { loadMyProfile } from './api/firestore';

/**
 * The name this person gave on the last screen of signing up (`users/{uid}.displayName`), or
 * `''` while it is still being read — and for somebody who left it blank, which is a real
 * answer: nothing draws a placeholder in its place.
 *
 * It is not the chain nickname. That one is `^[a-z0-9_]{3,20}$`, cannot hold a Korean name,
 * and costs a sponsored write to set; this is a Firestore field and a handle for people to
 * read (plan section E-3).
 */
export function useDisplayName(): string {
  const [name, setName] = useState('');

  useEffect(() => {
    let live = true;
    void loadMyProfile()
      .then((profile) => {
        if (live && profile !== null) setName(profile.displayName);
      })
      // Offline, or a document nobody has written yet. A missing name is not an error here:
      // every screen that reads this one already draws nothing when it is empty.
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, []);

  return name;
}
