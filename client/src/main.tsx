import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createBrowserRouter, Navigate, Route, RouterProvider, Routes } from 'react-router';
import './index.css';
import { setUnauthorizedHandler } from './lib/api';
import { useMe } from './lib/queries';
import { ChooseNewPassword } from './pages/ChooseNewPassword';
import { Layout } from './components/Layout';
import { EditorOnly } from './components/ReadOnly';
import { Spinner } from './components/ui';
import { Login } from './pages/Login';
import { Dashboard } from './pages/Dashboard';
import { IncomeList } from './pages/IncomeList';
import { IncomeForm } from './pages/IncomeForm';
import { IncomeView } from './pages/IncomeView';
import { ExpenseList } from './pages/ExpenseList';
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
import { CompareYears } from './pages/reports/CompareYears';
import { TaxEstimate } from './pages/reports/TaxEstimate';
import { SelfAssessmentLayout } from './pages/selfAssessment/SelfAssessmentLayout';
import { YearEndSummary } from './pages/selfAssessment/YearEndSummary';
import { SettingsLayout } from './pages/settings/SettingsLayout';
import { TaxYearsSettings } from './pages/settings/TaxYearsSettings';
import { CustomCategories } from './pages/settings/CustomCategories';
import { BackupSettings } from './pages/settings/BackupSettings';
import { Users } from './pages/settings/Users';
import { HmrcSettings } from './pages/settings/HmrcSettings';
import { UpdatesSettings } from './pages/settings/UpdatesSettings';
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
  if (data.mustChangePassword) return <ChooseNewPassword />;

  return (
    <Routes>
      <Route element={<Layout />}>
        <Route index element={<Dashboard />} />
        <Route path="income" element={<IncomeList />} />
        <Route
          path="income/new"
          element={
            <EditorOnly title="Add income">
              <IncomeForm />
            </EditorOnly>
          }
        />
        <Route path="income/:id" element={<IncomeView />} />
        <Route
          path="income/:id/edit"
          element={
            <EditorOnly title="Edit income">
              <IncomeForm />
            </EditorOnly>
          }
        />
        <Route path="expenses" element={<ExpenseList />} />
        <Route
          path="expenses/new"
          element={
            <EditorOnly title="Add expense">
              <ExpenseForm />
            </EditorOnly>
          }
        />
        <Route path="expenses/:id" element={<ExpenseView />} />
        <Route
          path="expenses/:id/edit"
          element={
            <EditorOnly title="Edit expense">
              <ExpenseForm />
            </EditorOnly>
          }
        />
        <Route path="claims" element={<ClaimsLayout />}>
          <Route path="mileage" element={<Mileage />} />
          <Route path="use-of-home" element={<UseOfHome />} />
        </Route>
        <Route path="mileage" element={<Navigate to="/claims/mileage" replace />} />
        <Route path="use-of-home" element={<Navigate to="/claims/use-of-home" replace />} />
        <Route path="mtd" element={<MtdLayout />}>
          <Route path="quarterly" element={<MtdQuarterly />} />
          <Route path="final-declaration" element={<FinalDeclaration />} />
          <Route path="tax-estimate" element={<Navigate to="/reports/tax-estimate" replace />} />
        </Route>
        <Route path="self-assessment" element={<SelfAssessmentLayout />}>
          <Route path="year-end" element={<YearEndSummary />} />
          <Route path="tax-estimate" element={<Navigate to="/reports/tax-estimate" replace />} />
        </Route>
        <Route path="reports" element={<ReportsLayout />}>
          <Route path="tax-estimate" element={<TaxEstimate />} />
          <Route path="breakdown" element={<Breakdown />} />
          <Route path="compare-years" element={<CompareYears />} />
          <Route path="year-end" element={<Navigate to="/self-assessment/year-end" replace />} />
        </Route>
        <Route path="year-end" element={<Navigate to="/self-assessment/year-end" replace />} />
        <Route path="settings" element={<SettingsLayout />}>
          <Route path="tax-years" element={<TaxYearsSettings />} />
          <Route path="categories" element={<CustomCategories />} />
          <Route path="users" element={<Users />} />
          <Route path="people" element={<Navigate to="/settings/users" replace />} />
          <Route path="hmrc" element={<HmrcSettings />} />
          <Route
            path="backup"
            element={
              <EditorOnly title="Backup and Restore">
                <BackupSettings />
              </EditorOnly>
            }
          />
          <Route path="updates" element={<UpdatesSettings />} />
        </Route>
        <Route path="backup" element={<Navigate to="/settings/backup" replace />} />
        <Route path="tax-years" element={<Navigate to="/settings/tax-years" replace />} />
        <Route path="*" element={<NotFound />} />
      </Route>
    </Routes>
  );
}

// A data router, so forms can ask before the page is left (useBlocker); the routes themselves stay in App.
const router = createBrowserRouter([{ path: '*', element: <App /> }]);

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>
  </StrictMode>,
);
