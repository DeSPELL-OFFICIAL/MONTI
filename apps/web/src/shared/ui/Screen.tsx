import type { ReactNode } from 'react';

export function Screen({ title, children }: { title?: string; children: ReactNode }) {
  return (
    <main className="screen">
      {title ? <h1>{title}</h1> : null}
      {children}
    </main>
  );
}
