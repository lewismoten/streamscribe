import { useEffect, useRef, type ReactNode } from 'react';
import { useLocation } from 'react-router';

// A group of the site's pages in the top bar (Public bodies, Research, Manage): its name opens a list of its pages,
// and it's marked when one of them is open. Going to a page, or clicking elsewhere, closes it.
export default function NavMenu({ label, paths, children }: { label: string; paths: string[]; children: ReactNode }) {
  const menu = useRef<HTMLDetailsElement>(null);
  const { pathname } = useLocation();
  const here = paths.some((path) => pathname === path || pathname.startsWith(`${path}/`));
  // Closed on going to another page.
  useEffect(() => {
    menu.current?.removeAttribute('open');
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- the page is what it follows
  }, [pathname]);
  useEffect(() => {
    const outside = (event: PointerEvent) => {
      if (menu.current && !menu.current.contains(event.target as Node)) menu.current.removeAttribute('open');
    };
    window.addEventListener('pointerdown', outside);
    return () => window.removeEventListener('pointerdown', outside);
  }, []);
  return (
    <details ref={menu} className={`nav-menu${here ? ' active' : ''}`}>
      <summary>{label}</summary>
      <div className="nav-menu-list">{children}</div>
    </details>
  );
}
