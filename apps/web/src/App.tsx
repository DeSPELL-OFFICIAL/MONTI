import { useEffect } from 'react';
import { RouterProvider, createBrowserRouter } from 'react-router-dom';
import { QueryClientProvider } from '@tanstack/react-query';
import { routes } from './router';
import { queryClient } from './shared/query';
import { bootSession } from './shared/session';
import './shared/theme.css';

const router = createBrowserRouter(routes);

export function App() {
  useEffect(() => bootSession(), []);
  return (
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  );
}
