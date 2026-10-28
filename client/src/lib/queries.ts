import { useEffect } from 'react';
import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import type {
  AutoBackupStatus,
  BreakdownItem,
  BreakdownResponse,
  Category,
  DashboardData,
  ExpenseWithLineItems,
  Income,
  MeResponse,
  MtdQuartersResponse,
  TaxYear,
  TaxYearsResponse,
  TransactionFilters,
  User,
  YearEndSummaryResponse,
} from '@crafty/shared';
import { api, CLIENT_ID, toQuery } from './api';

// ---- Auth ----

/** Drops cached data on sign-in/out, keeping the ['me'] query that App observes. */
const clearDataQueries = (qc: QueryClient) => qc.removeQueries({ predicate: (q) => q.queryKey[0] !== 'me' });

export const useMe = () =>
  useQuery({
    queryKey: ['me'],
    queryFn: () => api.get<MeResponse>('/auth/me'),
    staleTime: Infinity,
  });

export function useLogin() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (credentials: { name: string; password: string }) => api.post<MeResponse>('/auth/login', credentials),
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

// ---- Live updates ----

/**
 * Listens for changes made in other browsers (another person, or another tab)
 * and refetches, so everyone sees the same books without reloading. Forms
 * don't lose what you've typed: they only fill themselves once.
 */
export function useLiveUpdates() {
  const qc = useQueryClient();
  useEffect(() => {
    const source = new EventSource(`/api/events?client=${CLIENT_ID}`);
    const refetch = (area?: string) =>
      qc.invalidateQueries({ predicate: (q) => q.queryKey[0] !== 'me' || area === 'users' });
    source.addEventListener('changed', (e) => refetch((JSON.parse((e as MessageEvent).data) as { area: string }).area));
    // After a dropped connection (e.g. the server restarted), catch up on anything missed.
    let dropped = false;
    source.addEventListener('error', () => (dropped = true));
    source.addEventListener('open', () => {
      if (dropped) refetch();
      dropped = false;
    });
    return () => source.close();
  }, [qc]);
}

// ---- People ----

export const useUsers = () => useQuery({ queryKey: ['users'], queryFn: () => api.get<User[]>('/users') });

export function useUserMutations() {
  const qc = useQueryClient();
  const onSuccess = () => {
    qc.invalidateQueries({ queryKey: ['users'] });
    qc.invalidateQueries({ queryKey: ['me'] });
  };
  return {
    create: useMutation({
      mutationFn: (input: { name: string; password: string }) => api.post<User>('/users', input),
      onSuccess,
    }),
    update: useMutation({
      mutationFn: ({ id, ...input }: { id: number; name?: string; password?: string }) => api.put<User>(`/users/${id}`, input),
      onSuccess,
    }),
    remove: useMutation({ mutationFn: (id: number) => api.delete(`/users/${id}`), onSuccess }),
  };
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

export function useCategoryMutations() {
  const qc = useQueryClient();
  // Category names and usage appear on transactions and the dashboard too.
  const onSuccess = () => {
    qc.invalidateQueries({ queryKey: ['categories'] });
    qc.invalidateQueries({ queryKey: ['incomes'] });
    qc.invalidateQueries({ queryKey: ['expenses'] });
    qc.invalidateQueries({ queryKey: ['dashboard'] });
    qc.invalidateQueries({ queryKey: ['reports'] });
  };
  type Input = { name: string; mapsToCategoryId: number };
  return {
    create: useMutation({ mutationFn: (input: Input) => api.post<Category>('/categories', input), onSuccess }),
    update: useMutation({
      mutationFn: ({ id, ...input }: Input & { id: number }) => api.put<Category>(`/categories/${id}`, input),
      onSuccess,
    }),
    remove: useMutation({
      mutationFn: (id: number) => api.delete<{ incomes: number; lineItems: number; reassignedTo: Category }>(`/categories/${id}`),
      onSuccess,
    }),
  };
}

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
    queryFn: () => api.get<ExpenseWithLineItems[]>(`/expenses${filterQuery(filters!)}`),
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
    qc.invalidateQueries({ queryKey: ['reports'] });
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

// ---- UI state ----

const EXPANDED_KEY = ['ui', 'outgoing-expanded'];

/**
 * Which Outgoing rows are expanded. Kept in the query cache (never garbage
 * collected) so it survives moving between sections; it's cleared on sign-in
 * and sign-out with the rest of the cache, and on a page refresh.
 */
export function useExpandedOutgoingRows() {
  const qc = useQueryClient();
  const { data: ids } = useQuery({
    queryKey: EXPANDED_KEY,
    queryFn: () => [] as number[],
    initialData: [] as number[],
    staleTime: Infinity,
    gcTime: Infinity,
  });
  const toggle = (id: number) =>
    qc.setQueryData<number[]>(EXPANDED_KEY, (prev = []) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  return { isExpanded: (id: number) => ids.includes(id), toggle };
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

// ---- Automatic backups ----

export const useAutoBackup = () =>
  useQuery({ queryKey: ['auto-backup'], queryFn: () => api.get<AutoBackupStatus>('/backup/auto') });

export function useAutoBackupMutations() {
  const qc = useQueryClient();
  const onSuccess = (data: AutoBackupStatus) => qc.setQueryData(['auto-backup'], data);
  return {
    save: useMutation({
      mutationFn: (settings: { enabled: boolean; time: string; keep: number }) => api.put<AutoBackupStatus>('/backup/auto', settings),
      onSuccess,
    }),
    runNow: useMutation({
      mutationFn: () => api.post<AutoBackupStatus>('/backup/auto/run'),
      onSuccess,
      onError: () => qc.invalidateQueries({ queryKey: ['auto-backup'] }),
    }),
  };
}

// ---- Sample data ----

export const useSampleData = () =>
  useQuery({
    queryKey: ['sample-data'],
    queryFn: () => api.get<{ loaded: boolean; canLoad: boolean }>('/sample-data'),
  });

export function useLoadSampleData() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.post('/sample-data'),
    // Everything changes, so refetch it all (staying signed in).
    onSuccess: () => qc.resetQueries({ predicate: (q) => q.queryKey[0] !== 'me' }),
  });
}

// ---- Reports ----

export const useBreakdown = (from: string, to: string) =>
  useQuery({
    queryKey: ['reports', 'breakdown', from, to],
    queryFn: () => api.get<BreakdownResponse>(`/reports/breakdown${toQuery({ from, to })}`),
    enabled: Boolean(from && to && from <= to),
    placeholderData: (prev) => prev,
  });

export type BreakdownSelection = { categoryId: number; group: boolean } | { payee: string };

export const useBreakdownItems = (from: string, to: string, selection: BreakdownSelection | null) =>
  useQuery({
    queryKey: ['reports', 'breakdown-items', from, to, selection],
    queryFn: () =>
      api.get<BreakdownItem[]>(
        `/reports/breakdown/items${toQuery(
          selection && 'payee' in selection
            ? { from, to, payee: selection.payee }
            : { from, to, categoryId: selection!.categoryId, group: selection!.group ? '1' : '0' },
        )}`,
      ),
    enabled: selection !== null && Boolean(from && to && from <= to),
  });

export const useYearEndSummary = (taxYearId: number | undefined) =>
  useQuery({
    queryKey: ['mtd', 'year-end', taxYearId],
    queryFn: () => api.get<YearEndSummaryResponse>(`/reports/year-end${toQuery({ taxYearId })}`),
    enabled: taxYearId !== undefined,
  });

// ---- Dashboard ----

export const useDashboard = (taxYearId: number | undefined) =>
  useQuery({
    queryKey: ['dashboard', taxYearId],
    queryFn: () => api.get<DashboardData>(`/dashboard${toQuery({ taxYearId })}`),
    enabled: taxYearId !== undefined,
  });
