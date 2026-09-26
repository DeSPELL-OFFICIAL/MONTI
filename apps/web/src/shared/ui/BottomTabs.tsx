import { NavLink } from 'react-router-dom';
import type { ReactNode } from 'react';
import { useCopy } from '../i18n';

/**
 * The four glyphs. They are drawn here rather than fetched because the app ships no icon font
 * and loads nothing from another origin (the CSP in `vercel.json` allows neither), and because
 * four outlines at one stroke weight are smaller inline than any library that could draw them.
 *
 * Each is `aria-hidden`: the label under it is the accessible name, so a screen reader — and
 * `getByRole('link', { name: '내 티켓' })` — reads one word and not two.
 */
const GLYPHS: Readonly<Record<string, ReactNode>> = {
  discover: <><circle cx="11" cy="11" r="6.4" /><path d="m16 16 4.2 4.2" /></>,
  tickets: (
    <>
      <path d="M3.6 8.4a2 2 0 0 1 2-2h12.8a2 2 0 0 1 2 2v1.7a2.1 2.1 0 0 0 0 3.8v1.7a2 2 0 0 1-2 2H5.6a2 2 0 0 1-2-2v-1.7a2.1 2.1 0 0 0 0-3.8Z" />
      <path d="M14.4 6.4v11.2" strokeDasharray="2.2 2.2" />
    </>
  ),
  chats: <path d="M20.4 12.2c0 3.8-3.6 6.8-8 6.8a9.6 9.6 0 0 1-2.6-.35L4.8 20.2l1-3.3a6.4 6.4 0 0 1-2.2-4.7c0-3.8 3.6-6.8 8-6.8s8.8 3 8.8 6.8Z" />,
  me: <><circle cx="12" cy="8.6" r="3.6" /><path d="M5.2 19.6a6.8 6.8 0 0 1 13.6 0" /></>,
};

function Glyph({ name }: { name: string }) {
  return (
    <svg
      className="tabbar__icon"
      viewBox="0 0 24 24"
      width="22"
      height="22"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {GLYPHS[name]}
    </svg>
  );
}

export function BottomTabs() {
  const copy = useCopy();
  const tabs = [
    { to: '/', name: 'discover', label: copy.tabs.discover, end: true },
    { to: '/tickets', name: 'tickets', label: copy.tabs.tickets, end: false },
    { to: '/chats', name: 'chats', label: copy.tabs.chats, end: false },
    { to: '/me', name: 'me', label: copy.tabs.me, end: false },
  ];
  return (
    <nav className="tabbar">
      {tabs.map((tab) => (
        <NavLink key={tab.to} to={tab.to} end={tab.end}>
          <Glyph name={tab.name} />
          <span>{tab.label}</span>
        </NavLink>
      ))}
    </nav>
  );
}
