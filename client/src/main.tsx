import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter, Route, Routes } from 'react-router';
import './index.css';
import { setUnauthorizedHandler } from './lib/api';
import { useMe } from './lib/queries';
import { Layout } from './components/Layout';
import { Spinner } from './components/ui';
import { Login } from './pages/Login';
import { Dashboard } from './pages/Dashboard';
import { IncomingList } from './pages/IncomingList';
import { IncomeForm } from './pages/IncomeForm';
import { IncomeView } from './pages/IncomeView';
import { OutgoingList } from './pages/OutgoingList';
import { ExpenseForm } from './pages/ExpenseForm';
import { ExpenseView } from './pages/ExpenseView';
import { TaxYears } from './pages/TaxYears';
import { Backup } from './pages/Backup';
import { NotFound } from './pages/NotFound';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: (count, err) => (err as { status?: number }).status !== 401 && count < 2, refetchOnWindowFocus: false },
  },
});

setUnauthorizedHandler(() => queryClient.setQueryData(['me'], { authenticated: false }));

function App() {
  const { data, isLoading } = useMe();
  if (isLoading) return <Spinner />;
  if (!data?.authenticated) return <Login />;

  return (
    <Routes>
      <Route element={<Layout />}>
        <Route index element={<Dashboard />} />
        <Route path="incoming" element={<IncomingList />} />
        <Route path="incoming/new" element={<IncomeForm />} />
        <Route path="incoming/:id" element={<IncomeView />} />
        <Route path="incoming/:id/edit" element={<IncomeForm />} />
        <Route path="outgoing" element={<OutgoingList />} />
        <Route path="outgoing/new" element={<ExpenseForm />} />
        <Route path="outgoing/:id" element={<ExpenseView />} />
        <Route path="outgoing/:id/edit" element={<ExpenseForm />} />
        <Route path="tax-years" element={<TaxYears />} />
        <Route path="backup" element={<Backup />} />
        <Route path="*" element={<NotFound />} />
      </Route>
    </Routes>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
);
