import { NavLink } from 'react-router-dom';
import { useCopy } from '../i18n';

export function BottomTabs() {
  const copy = useCopy();
  const tabs = [
    { to: '/', label: copy.tabs.discover, end: true },
    { to: '/tickets', label: copy.tabs.tickets, end: false },
    { to: '/chats', label: copy.tabs.chats, end: false },
    { to: '/me', label: copy.tabs.me, end: false },
  ];
  return (
    <nav className="tabbar">
      {tabs.map((tab) => (
        <NavLink key={tab.to} to={tab.to} end={tab.end}>
          {tab.label}
        </NavLink>
      ))}
    </nav>
  );
}
