import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router';
import './index.css';
import { setUnauthorizedHandler } from './lib/api';
import { useMe } from './lib/queries';
import { Layout } from './components/Layout';
import { EditorOnly } from './components/ReadOnly';
import { Spinner } from './components/ui';
import { Login } from './pages/Login';
import { Dashboard } from './pages/Dashboard';
import { IncomingList } from './pages/IncomingList';
import { IncomeForm } from './pages/IncomeForm';
import { IncomeView } from './pages/IncomeView';
import { OutgoingList } from './pages/OutgoingList';
import { ExpenseForm } from './pages/ExpenseForm';
import { ExpenseView } from './pages/ExpenseView';
import { ClaimsLayout } from './pages/claims/ClaimsLayout';
import { Mileage } from './pages/claims/Mileage';
import { UseOfHome } from './pages/claims/UseOfHome';
import { MtdLayout } from './pages/mtd/MtdLayout';
import { MtdQuarterly } from './pages/mtd/MtdQuarterly';
import { FinalDeclaration } from './pages/mtd/FinalDeclaration';
import { ReportsLayout } from './pages/reports/ReportsLayout';
import { Breakdown } from './pages/reports/Breakdown';
import { TaxEstimate } from './pages/reports/TaxEstimate';
import { SelfAssessmentLayout } from './pages/selfAssessment/SelfAssessmentLayout';
import { YearEndSummary } from './pages/selfAssessment/YearEndSummary';
import { SettingsLayout } from './pages/settings/SettingsLayout';
import { TaxYearsSettings } from './pages/settings/TaxYearsSettings';
import { CustomCategories } from './pages/settings/CustomCategories';
import { BackupSettings } from './pages/settings/BackupSettings';
import { People } from './pages/settings/People';
import { HmrcSettings } from './pages/settings/HmrcSettings';
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
        <Route
          path="incoming/new"
          element={
            <EditorOnly title="Add incoming">
              <IncomeForm />
            </EditorOnly>
          }
        />
        <Route path="incoming/:id" element={<IncomeView />} />
        <Route
          path="incoming/:id/edit"
          element={
            <EditorOnly title="Edit incoming">
              <IncomeForm />
            </EditorOnly>
          }
        />
        <Route path="outgoing" element={<OutgoingList />} />
        <Route
          path="outgoing/new"
          element={
            <EditorOnly title="Add outgoing">
              <ExpenseForm />
            </EditorOnly>
          }
        />
        <Route path="outgoing/:id" element={<ExpenseView />} />
        <Route
          path="outgoing/:id/edit"
          element={
            <EditorOnly title="Edit outgoing">
              <ExpenseForm />
            </EditorOnly>
          }
        />
        <Route path="claims" element={<ClaimsLayout />}>
          <Route index element={<Navigate to="mileage" replace />} />
          <Route path="mileage" element={<Mileage />} />
          <Route path="use-of-home" element={<UseOfHome />} />
        </Route>
        <Route path="mileage" element={<Navigate to="/claims/mileage" replace />} />
        <Route path="use-of-home" element={<Navigate to="/claims/use-of-home" replace />} />
        <Route path="mtd" element={<MtdLayout />}>
          <Route index element={<Navigate to="quarterly" replace />} />
          <Route path="quarterly" element={<MtdQuarterly />} />
          <Route path="final-declaration" element={<FinalDeclaration />} />
          <Route path="tax-estimate" element={<Navigate to="/reports/tax-estimate" replace />} />
        </Route>
        <Route path="self-assessment" element={<SelfAssessmentLayout />}>
          <Route index element={<Navigate to="year-end" replace />} />
          <Route path="year-end" element={<YearEndSummary />} />
          <Route path="tax-estimate" element={<Navigate to="/reports/tax-estimate" replace />} />
        </Route>
        <Route path="reports" element={<ReportsLayout />}>
          <Route index element={<Navigate to="tax-estimate" replace />} />
          <Route path="tax-estimate" element={<TaxEstimate />} />
          <Route path="breakdown" element={<Breakdown />} />
          <Route path="year-end" element={<Navigate to="/self-assessment/year-end" replace />} />
        </Route>
        <Route path="year-end" element={<Navigate to="/self-assessment/year-end" replace />} />
        <Route path="settings" element={<SettingsLayout />}>
          <Route index element={<Navigate to="tax-years" replace />} />
          <Route path="tax-years" element={<TaxYearsSettings />} />
          <Route path="categories" element={<CustomCategories />} />
          <Route path="people" element={<People />} />
          <Route path="hmrc" element={<HmrcSettings />} />
          <Route
            path="backup"
            element={
              <EditorOnly title="Backup and restore">
                <BackupSettings />
              </EditorOnly>
            }
          />
        </Route>
        <Route path="backup" element={<Navigate to="/settings/backup" replace />} />
        <Route path="tax-years" element={<Navigate to="/settings/tax-years" replace />} />
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
