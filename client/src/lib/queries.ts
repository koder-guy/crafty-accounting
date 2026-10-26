import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import type {
  Category,
  DashboardData,
  Expense,
  ExpenseWithLineItems,
  Income,
  MtdQuartersResponse,
  TaxYear,
  TaxYearsResponse,
  TransactionFilters,
} from '@crafty/shared';
import { api, toQuery } from './api';

// ---- Auth ----

/** Drops cached data on sign-in/out, keeping the ['me'] query that App observes. */
const clearDataQueries = (qc: QueryClient) => qc.removeQueries({ predicate: (q) => q.queryKey[0] !== 'me' });

export const useMe = () =>
  useQuery({
    queryKey: ['me'],
    queryFn: () => api.get<{ authenticated: boolean }>('/auth/me'),
    staleTime: Infinity,
  });

export function useLogin() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (password: string) => api.post<{ authenticated: boolean }>('/auth/login', { password }),
    onSuccess: (data) => {
      clearDataQueries(qc);
      qc.setQueryData(['me'], data);
    },
  });
}

export function useLogout() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.post('/auth/logout'),
    onSuccess: () => {
      clearDataQueries(qc);
      qc.setQueryData(['me'], { authenticated: false });
    },
  });
}

// ---- Tax years ----

export const useTaxYears = () =>
  useQuery({ queryKey: ['tax-years'], queryFn: () => api.get<TaxYearsResponse>('/tax-years') });

/** The active tax year, or null once loaded if none exist. */
export function useActiveTaxYear(): { taxYear: TaxYear | null; isLoading: boolean } {
  const { data, isLoading } = useTaxYears();
  const taxYear = data?.taxYears.find((y) => y.id === data.activeTaxYearId) ?? null;
  return { taxYear, isLoading };
}

export function useTaxYearMutations() {
  const qc = useQueryClient();
  const onSuccess = (data: TaxYearsResponse) => {
    qc.setQueryData(['tax-years'], data);
    qc.invalidateQueries({ predicate: (q) => q.queryKey[0] !== 'tax-years' && q.queryKey[0] !== 'me' });
  };
  return {
    create: useMutation({
      mutationFn: (startYear: number) => api.post<TaxYearsResponse>('/tax-years', { startYear }),
      onSuccess,
    }),
    setActive: useMutation({
      mutationFn: (taxYearId: number) => api.put<TaxYearsResponse>('/tax-years/active', { taxYearId }),
      onSuccess,
    }),
    remove: useMutation({
      mutationFn: (id: number) => api.delete<TaxYearsResponse>(`/tax-years/${id}`),
      onSuccess,
    }),
  };
}

// ---- Categories ----

export const useCategories = () =>
  useQuery({ queryKey: ['categories'], queryFn: () => api.get<Category[]>('/categories'), staleTime: Infinity });

// ---- Transactions ----

type Kind = 'incomes' | 'expenses';

const filterQuery = (filters: TransactionFilters) =>
  toQuery({
    taxYearId: filters.taxYearId,
    search: filters.search,
    from: filters.from,
    to: filters.to,
    categoryId: filters.categoryId,
    paymentMethod: filters.paymentMethod,
    minPence: filters.minPence,
    maxPence: filters.maxPence,
  });

export const exportCsvUrl = (kind: Kind, filters: TransactionFilters) => `/api/${kind}/export.csv${filterQuery(filters)}`;

export const useIncomes = (filters: TransactionFilters | null) =>
  useQuery({
    queryKey: ['incomes', 'list', filters],
    queryFn: () => api.get<Income[]>(`/incomes${filterQuery(filters!)}`),
    enabled: filters !== null,
    placeholderData: (prev) => prev,
  });

export const useExpenses = (filters: TransactionFilters | null) =>
  useQuery({
    queryKey: ['expenses', 'list', filters],
    queryFn: () => api.get<Expense[]>(`/expenses${filterQuery(filters!)}`),
    enabled: filters !== null,
    placeholderData: (prev) => prev,
  });

export const useIncome = (id: number | null) =>
  useQuery({ queryKey: ['incomes', id], queryFn: () => api.get<Income>(`/incomes/${id}`), enabled: id !== null });

export const useExpense = (id: number | null) =>
  useQuery({
    queryKey: ['expenses', id],
    queryFn: () => api.get<ExpenseWithLineItems>(`/expenses/${id}`),
    enabled: id !== null,
  });

function useInvalidateTransactions(kind: Kind) {
  const qc = useQueryClient();
  return () => {
    qc.invalidateQueries({ queryKey: [kind] });
    qc.invalidateQueries({ queryKey: ['dashboard'] });
    qc.invalidateQueries({ queryKey: ['mtd'] });
    qc.invalidateQueries({ queryKey: ['tax-years'] });
  };
}

export function useSaveTransaction<T>(kind: Kind) {
  const invalidate = useInvalidateTransactions(kind);
  return useMutation({
    mutationFn: ({ id, form }: { id?: number; form: FormData }) =>
      id ? api.put<T>(`/${kind}/${id}`, form) : api.post<T>(`/${kind}`, form),
    onSuccess: invalidate,
  });
}

export function useDeleteTransaction(kind: Kind) {
  const invalidate = useInvalidateTransactions(kind);
  return useMutation({ mutationFn: (id: number) => api.delete(`/${kind}/${id}`), onSuccess: invalidate });
}

// ---- MTD ----

export const useMtdQuarters = (taxYearId: number | undefined) =>
  useQuery({
    queryKey: ['mtd', taxYearId],
    queryFn: () => api.get<MtdQuartersResponse>(`/mtd/quarters${toQuery({ taxYearId })}`),
    enabled: taxYearId !== undefined,
  });

export function useMtdSubmission(taxYearId: number) {
  const qc = useQueryClient();
  const onSuccess = () => qc.invalidateQueries({ queryKey: ['mtd', taxYearId] });
  const path = (quarter: number) => `/mtd/quarters/${taxYearId}/${quarter}/submission`;
  return {
    save: useMutation({
      mutationFn: ({ quarter, submittedOn, reference }: { quarter: number; submittedOn: string; reference: string }) =>
        api.put(path(quarter), { submittedOn, reference }),
      onSuccess,
    }),
    clear: useMutation({ mutationFn: (quarter: number) => api.delete(path(quarter)), onSuccess }),
  };
}

// ---- Dashboard ----

export const useDashboard = (taxYearId: number | undefined) =>
  useQuery({
    queryKey: ['dashboard', taxYearId],
    queryFn: () => api.get<DashboardData>(`/dashboard${toQuery({ taxYearId })}`),
    enabled: taxYearId !== undefined,
  });
