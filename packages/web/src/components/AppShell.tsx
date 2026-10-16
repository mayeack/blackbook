import type { ReactNode } from 'react';
import { Link, NavLink, useLocation } from 'react-router';
import { Icons } from './icons';

interface NavItem {
  to: string;
  label: string;
  icon: ReactNode;
}

const TODAY: NavItem = { to: '/today', label: 'Today', icon: Icons.today };
const PEOPLE: NavItem = { to: '/people', label: 'People', icon: Icons.people };
const ASK: NavItem = { to: '/ask', label: 'Ask', icon: Icons.ask };
const NETWORK: NavItem = { to: '/network', label: 'Network', icon: Icons.network };
const CIRCLES: NavItem = { to: '/circles', label: 'Circles', icon: Icons.circles };
const EVENTS: NavItem = { to: '/events', label: 'Events', icon: Icons.events };
const SOURCES: NavItem = { to: '/sources', label: 'Sources', icon: Icons.sources };
const SETTINGS: NavItem = { to: '/settings', label: 'Settings', icon: Icons.settings };

/** Desktop sidebar: everything. */
const SIDEBAR = [TODAY, PEOPLE, ASK, NETWORK, CIRCLES, EVENTS, SOURCES, SETTINGS];
/** Screens reached through the More tab on mobile. */
export const MORE_ITEMS = [CIRCLES, EVENTS, SOURCES, SETTINGS];
/** Detail screens of the More items: events and trips belong to Events, collections to Circles. */
const EVENT_PATHS = ['/e', '/trips'];
const CIRCLE_PATHS = ['/c', '/tags', '/locations'];
const MORE_PATHS = ['/more', ...EVENT_PATHS, ...CIRCLE_PATHS, ...MORE_ITEMS.map((i) => i.to)];
const under = (pathname: string, paths: readonly string[]) => paths.some((p) => pathname === p || pathname.startsWith(`${p}/`));

const navClass = ({ isActive }: { isActive: boolean }) => (isActive ? 'active' : undefined);

export function AppShell({ children }: { children: ReactNode }) {
  const { pathname } = useLocation();
  const inMore = under(pathname, MORE_PATHS);
  // A person page belongs to People; an event or trips page to Events; a circle, tag or place to Circles.
  const inPeople = pathname.startsWith('/p/');
  const inEvents = under(pathname, EVENT_PATHS);
  const inCircles = under(pathname, CIRCLE_PATHS);
  const activeFor = (n: NavItem) => (n === PEOPLE && inPeople) || (n === EVENTS && inEvents) || (n === CIRCLES && inCircles);

  return (
    <div className="shell">
      <aside className="shell-side">
        <Link to="/today" className="shell-brand">
          <img src="/icons/icon.svg" width={26} height={26} alt="" />
          <span>yeackbot</span>
        </Link>
        <nav className="shell-nav" aria-label="Main">
          {SIDEBAR.map((n) => (
            <NavLink key={n.to} to={n.to} className={activeFor(n) ? 'active' : navClass}>
              {n.icon}
              <span>{n.label}</span>
            </NavLink>
          ))}
        </nav>
      </aside>
      <div className="shell-main">
        <main className="page">{children}</main>
      </div>
      <nav className="tabbar" aria-label="Tabs">
        {[TODAY, PEOPLE, ASK, NETWORK].map((n) => (
          <NavLink key={n.to} to={n.to} className={n === PEOPLE && inPeople ? 'active' : navClass}>
            {n.icon}
            <span>{n.label}</span>
          </NavLink>
        ))}
        <NavLink to="/more" className={inMore ? 'active' : undefined} aria-current={inMore ? 'page' : undefined}>
          {Icons.more}
          <span>More</span>
        </NavLink>
      </nav>
    </div>
  );
}
