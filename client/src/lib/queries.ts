import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import type {
  AutoBackupStatus,
  BreakdownItem,
  BreakdownResponse,
  Category,
  DashboardData,
  ExpenseWithLineItems,
  FlatRateKind,
  HmrcBusiness,
  HmrcCalculationResponse,
  HmrcFraudHeaderCheck,
  HmrcObligation,
  HmrcStatus,
  Income,
  MeResponse,
  MileageInput,
  MileageResponse,
  MileageTrip,
  MtdPayload,
  MtdQuarterSubmission,
  MtdQuartersResponse,
  Role,
  TaxEstimateResponse,
  TaxYear,
  TaxYearsResponse,
  UseOfHomeInput,
  UseOfHomeResponse,
  TransactionFilters,
  User,
  YearEndSummaryResponse,
} from '@crafty/shared';
import { api, toQuery } from './api';

// ---- Auth ----

/** Drops cached data on sign-in/out, keeping the ['me'] query that App observes. */
const clearDataQueries = (qc: QueryClient) => qc.removeQueries({ predicate: (q) => q.queryKey[0] !== 'me' });

export const useMe = () =>
  useQuery({
    queryKey: ['me'],
    queryFn: () => api.get<MeResponse>('/auth/me'),
    staleTime: Infinity,
  });

/** Whether the signed-in person can change the books (read-only people can only view, export and print). */
export function useCanEdit(): boolean {
  const { data } = useMe();
  return data?.user?.role !== 'viewer';
}

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
      mutationFn: (input: { name: string; password: string; role: Role }) => api.post<User>('/users', input),
      onSuccess,
    }),
    update: useMutation({
      mutationFn: ({ id, ...input }: { id: number; name?: string; password?: string; role?: Role }) =>
        api.put<User>(`/users/${id}`, input),
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

function useInvalidateTransactions(kind: Kind | 'mileage' | 'use-of-home') {
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

// ---- HMRC ----

export const HMRC_OBLIGATIONS = 'hmrc-obligations';

export const useHmrc = () => useQuery({ queryKey: ['hmrc'], queryFn: () => api.get<HmrcStatus>('/hmrc') });

export function useHmrcMutations() {
  const qc = useQueryClient();
  const onSuccess = () => {
    qc.invalidateQueries({ queryKey: ['hmrc'] });
    qc.invalidateQueries({ queryKey: [HMRC_OBLIGATIONS] });
  };
  return {
    saveNino: useMutation({ mutationFn: (nino: string | null) => api.put('/hmrc/nino', { nino }), onSuccess }),
    // Off to HMRC's sign-in page; it sends the browser back to Settings → HMRC.
    connect: useMutation({
      mutationFn: () => api.post<{ url: string }>('/hmrc/connect'),
      onSuccess: ({ url }) => window.location.assign(url),
    }),
    disconnect: useMutation({ mutationFn: () => api.delete('/hmrc/connection'), onSuccess }),
    findBusiness: useMutation({
      mutationFn: () => api.post<{ businesses: HmrcBusiness[] }>('/hmrc/businesses/find'),
      onSuccess,
    }),
    chooseBusiness: useMutation({ mutationFn: (business: HmrcBusiness) => api.put('/hmrc/business', business), onSuccess }),
    checkFraudHeaders: useMutation({ mutationFn: () => api.get<HmrcFraudHeaderCheck>('/hmrc/fraud-headers/check') }),
  };
}

/** Sends a quarter's year-to-date figures to HMRC, as previewed: the server refuses (409) if they've changed since. */
export function useSendToHmrc(taxYearId: number) {
  const qc = useQueryClient();
  const refresh = () => qc.invalidateQueries({ queryKey: ['mtd', taxYearId] });
  return useMutation({
    mutationFn: ({ quarter, payload }: { quarter: number; payload: MtdPayload }) =>
      api.post<MtdQuarterSubmission>(`/hmrc/quarters/${taxYearId}/${quarter}/send`, { payload }),
    onSuccess: () => {
      refresh();
      qc.invalidateQueries({ queryKey: [HMRC_OBLIGATIONS] });
    },
    onError: () => {
      refresh();
      // HMRC may have refused the sign-in, which the server then forgets.
      qc.invalidateQueries({ queryKey: ['hmrc'] });
    },
  });
}

export const HMRC_CALCULATION = 'hmrc-calculation';

/**
 * HMRC's latest tax calculation for the year, or the one just asked for
 * (`awaiting`), checked every 5 seconds until HMRC has worked it out.
 */
export function useHmrcCalculation(taxYearId: number | undefined, enabled: boolean, awaiting: string | null) {
  return useQuery({
    queryKey: [HMRC_CALCULATION, taxYearId, awaiting],
    queryFn: () => api.get<HmrcCalculationResponse>(`/hmrc/calculations/${taxYearId}${toQuery({ calculationId: awaiting })}`),
    enabled: enabled && taxYearId !== undefined,
    staleTime: 5 * 60 * 1000,
    retry: false,
    refetchInterval: (query) => (query.state.data?.state === 'pending' ? 5000 : false),
  });
}

export function useTriggerHmrcCalculation(taxYearId: number | undefined) {
  return useMutation({
    mutationFn: () => api.post<{ calculationId: string }>(`/hmrc/calculations/${taxYearId}`),
  });
}

/** What HMRC expects for the tax year. Each fetch is a call to HMRC, so it isn't refetched on every change (see liveUpdates.ts). */
export function useHmrcObligations(taxYearId: number | undefined, enabled: boolean) {
  const qc = useQueryClient();
  return useQuery({
    queryKey: [HMRC_OBLIGATIONS, taxYearId],
    queryFn: () =>
      api.get<HmrcObligation[]>(`/hmrc/obligations${toQuery({ taxYearId })}`).catch((err) => {
        // HMRC may have refused the sign-in, which the server then forgets.
        qc.invalidateQueries({ queryKey: ['hmrc'] });
        throw err;
      }),
    enabled: enabled && taxYearId !== undefined,
    staleTime: 5 * 60 * 1000,
    retry: false,
  });
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

// ---- Mileage ----

export const useMileage = (taxYearId: number | undefined) =>
  useQuery({
    queryKey: ['mileage', taxYearId],
    queryFn: () => api.get<MileageResponse>(`/mileage${toQuery({ taxYearId })}`),
    enabled: taxYearId !== undefined,
  });

export function useMileageMutations() {
  // Claims count as travel expenses, so every total changes.
  const invalidate = useInvalidateTransactions('mileage');
  return {
    save: useMutation({
      mutationFn: ({ id, ...input }: MileageInput & { id?: number }) =>
        id ? api.put<MileageTrip>(`/mileage/${id}`, input) : api.post<MileageTrip>('/mileage', input),
      onSuccess: invalidate,
    }),
    remove: useMutation({ mutationFn: (id: number) => api.delete(`/mileage/${id}`), onSuccess: invalidate }),
  };
}

// ---- Use of home ----

export const useUseOfHome = (taxYearId: number | undefined) =>
  useQuery({
    queryKey: ['use-of-home', taxYearId],
    queryFn: () => api.get<UseOfHomeResponse>(`/use-of-home${toQuery({ taxYearId })}`),
    enabled: taxYearId !== undefined,
  });

export function useSaveUseOfHome() {
  const qc = useQueryClient();
  // Claims count as premises costs, so every total changes.
  const invalidate = useInvalidateTransactions('use-of-home');
  return useMutation({
    mutationFn: (input: UseOfHomeInput) => api.put<UseOfHomeResponse>('/use-of-home', input),
    onSuccess: (saved, input) => {
      // Show the saved hours straight away, so the page doesn't mistake its own save for someone else's.
      qc.setQueryData(['use-of-home', input.taxYearId], saved);
      invalidate();
    },
  });
}

// ---- Tax estimate ----

export const useTaxEstimate = (taxYearId: number | undefined) =>
  useQuery({
    queryKey: ['reports', 'tax-estimate', taxYearId],
    queryFn: () => api.get<TaxEstimateResponse>(`/reports/tax-estimate${toQuery({ taxYearId })}`),
    enabled: taxYearId !== undefined,
  });

export function useTaxSettings() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ taxYearId, otherIncomePence }: { taxYearId: number; otherIncomePence: number }) =>
      api.put<TaxYearsResponse>(`/tax-years/${taxYearId}/tax-settings`, { otherIncomePence }),
    onSuccess: (data) => {
      qc.setQueryData(['tax-years'], data);
      qc.invalidateQueries({ queryKey: ['reports'] });
      qc.invalidateQueries({ queryKey: ['dashboard'] });
    },
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

export type BreakdownSelection = { categoryId: number; group: boolean } | { payee: string } | { flatRate: FlatRateKind };

export const useBreakdownItems = (from: string, to: string, selection: BreakdownSelection | null) =>
  useQuery({
    queryKey: ['reports', 'breakdown-items', from, to, selection],
    queryFn: () =>
      api.get<BreakdownItem[]>(
        `/reports/breakdown/items${toQuery(
          'payee' in selection!
            ? { from, to, payee: selection.payee }
            : 'flatRate' in selection!
              ? { from, to, flatRate: selection.flatRate }
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
