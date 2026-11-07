import { useEffect } from 'react';
import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import type {
  CategoryImportSummary,
  ImportSummary,
  MtdExpenses,
  SubmissionMethod,
  AutoBackupStatus,
  BreakdownItem,
  BreakdownResponse,
  ComparisonPeriod,
  YearComparisonResponse,
  Category,
  DashboardData,
  ExpenseWithLineItems,
  FlatRateKind,
  HmrcBusiness,
  HmrcCalculationResponse,
  MtdFinalDeclaration,
  HmrcFraudHeaderCheck,
  HmrcObligation,
  HmrcStatus,
  Income,
  ClaudeModel,
  ClaudeStatus,
  SquareImportResult,
  SquarePayoutList,
  SquareSettingsInput,
  SquareStatus,
  Scan,
  ScanList,
  MeResponse,
  NotificationsResponse,
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
  UpdateStatus,
} from '@crafty/shared';
import { APP_VERSION, MTD_FIRST_SEND_YEAR, startYearFromLabel } from '@crafty/shared';
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

/** Replaces the default password; the server then lets them into the rest of the app. */
export function useChooseNewPassword() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, password }: { id: number; password: string }) => api.put(`/users/${id}`, { password }),
    onSuccess: () => {
      clearDataQueries(qc);
      qc.invalidateQueries({ queryKey: ['me'] });
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
      mutationFn: (input: { startYear: number; submissionMethod: SubmissionMethod }) => api.post<TaxYearsResponse>('/tax-years', input),
      onSuccess,
    }),
    setSubmissionMethod: useMutation({
      mutationFn: ({ id, submissionMethod }: { id: number; submissionMethod: SubmissionMethod }) =>
        api.put<TaxYearsResponse>(`/tax-years/${id}/submission-method`, { submissionMethod }),
      onSuccess,
    }),
    setMtdExpenses: useMutation({
      mutationFn: ({ id, mtdExpenses }: { id: number; mtdExpenses: MtdExpenses }) =>
        api.put<TaxYearsResponse>(`/tax-years/${id}/mtd-expenses`, { mtdExpenses }),
      onSuccess,
    }),
    setFiled: useMutation({
      mutationFn: ({ id, filedOn }: { id: number; filedOn: string }) =>
        api.put<TaxYearsResponse>(`/tax-years/${id}/self-assessment-filed`, { filedOn }),
      onSuccess,
    }),
    clearFiled: useMutation({
      mutationFn: (id: number) => api.delete<TaxYearsResponse>(`/tax-years/${id}/self-assessment-filed`),
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
    /** Imports a custom categories export; `importPreview` only says what importing would do. */
    importRun: useMutation({ mutationFn: (file: unknown) => api.post<CategoryImportSummary>('/categories/import', file), onSuccess }),
    importPreview: useMutation({ mutationFn: (file: unknown) => api.post<CategoryImportSummary>('/categories/import/preview', file) }),
  };
}

export const CATEGORIES_EXPORT_URL = '/api/categories/export.json';

// ---- Transactions ----

export type Kind = 'incomes' | 'expenses';

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

export const exportUrl = (kind: Kind, filters: TransactionFilters, format: 'csv' | 'json') =>
  `/api/${kind}/export.${format}${filterQuery(filters)}`;

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

/** Settings → Claude Integration: whether a key is saved (shown only as a hint), the model and the filename pattern. */
export const useClaude = () => useQuery({ queryKey: ['claude'], queryFn: () => api.get<ClaudeStatus>('/claude') });

export function useClaudeMutations() {
  const qc = useQueryClient();
  const onSuccess = (status: ClaudeStatus) => qc.setQueryData(['claude'], status);
  return {
    save: useMutation({
      mutationFn: (body: { apiKey?: string; model?: ClaudeModel; filenamePattern?: string }) => api.put<ClaudeStatus>('/claude', body),
      onSuccess,
    }),
    removeKey: useMutation({ mutationFn: () => api.delete<ClaudeStatus>('/claude/key'), onSuccess }),
  };
}

/** Settings → Square: whether a token is saved (shown only as a hint), and the categories imports go into. */
export const useSquare = () => useQuery({ queryKey: ['square'], queryFn: () => api.get<SquareStatus>('/square') });

export function useSquareMutations() {
  const qc = useQueryClient();
  const onSuccess = (status: SquareStatus) => qc.setQueryData(['square'], status);
  return {
    save: useMutation({ mutationFn: (body: SquareSettingsInput) => api.put<SquareStatus>('/square', body), onSuccess }),
    removeToken: useMutation({ mutationFn: () => api.delete<SquareStatus>('/square/token'), onSuccess }),
  };
}

/** Square's payouts for a tax year's sales, fetched from Square each time it's asked (Income → Import from Square). */
export const useSquarePayouts = (taxYearId: number | null) =>
  useQuery({
    queryKey: ['square-payouts', taxYearId],
    queryFn: () => api.get<SquarePayoutList>(`/square/payouts?taxYearId=${taxYearId}`),
    enabled: taxYearId !== null,
    staleTime: Infinity,
    gcTime: 0,
    retry: false,
  });

export function useImportSquarePayouts() {
  const invalidateIncomes = useInvalidateTransactions('incomes');
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { taxYearId: number; payoutIds: string[] }) => api.post<SquareImportResult>('/square/import', body),
    onSuccess: () => {
      invalidateIncomes();
      qc.invalidateQueries({ queryKey: ['expenses'] });
      qc.invalidateQueries({ queryKey: ['square-payouts'] });
    },
  });
}

/** Documents scanned in bulk, waiting to be checked (Expenses → Scan documents). Live updates refetch it as Claude reads each. */
export const useScans = (enabled = true) => useQuery({ queryKey: ['scans'], queryFn: () => api.get<ScanList>('/scans'), enabled });

export function useScanMutations() {
  const qc = useQueryClient();
  const onSettled = () => qc.invalidateQueries({ queryKey: ['scans'] });
  return {
    add: useMutation({
      mutationFn: (file: File) => {
        const form = new FormData();
        form.append('document', file, file.name);
        return api.post<Scan>('/scans', form);
      },
      onSettled,
    }),
    retry: useMutation({ mutationFn: (id: number) => api.post<Scan>(`/scans/${id}/retry`), onSettled }),
    discard: useMutation({ mutationFn: (id: number) => api.delete(`/scans/${id}`), onSettled }),
  };
}

export const scanFileUrl = (id: number) => `/api/scans/${id}/file`;

/** Imports a JSON export; `preview` only says what importing would do. */
export function useImportTransactions(kind: Kind) {
  const invalidate = useInvalidateTransactions(kind);
  const run = useMutation({ mutationFn: (file: unknown) => api.post<ImportSummary>(`/${kind}/import`, file), onSuccess: invalidate });
  const preview = useMutation({ mutationFn: (file: unknown) => api.post<ImportSummary>(`/${kind}/import/preview`, file) });
  return { run, preview };
}

export function useDeleteTransaction(kind: Kind) {
  const invalidate = useInvalidateTransactions(kind);
  return useMutation({ mutationFn: (id: number) => api.delete(`/${kind}/${id}`), onSuccess: invalidate });
}

/** Deletes several transactions at once: the ones a table shows. */
export function useDeleteTransactions(kind: Kind) {
  const invalidate = useInvalidateTransactions(kind);
  return useMutation({
    mutationFn: (ids: number[]) => api.post<{ deleted: number }>(`/${kind}/delete`, { ids }),
    onSuccess: invalidate,
  });
}

// ---- UI state ----

/**
 * Which rows of the Income or Expenses table are expanded. Kept in the query cache (never garbage
 * collected) so it survives moving between sections; it's cleared on sign-in
 * and sign-out with the rest of the cache, and on a page refresh.
 */
export function useExpandedRows(table: 'incomes' | 'expenses') {
  const qc = useQueryClient();
  const key = ['ui', 'expanded', table];
  const { data: ids } = useQuery({
    queryKey: key,
    queryFn: () => [] as number[],
    initialData: [] as number[],
    staleTime: Infinity,
    gcTime: Infinity,
  });
  const toggle = (id: number) =>
    qc.setQueryData<number[]>(key, (prev = []) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
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
    remove: useMutation({
      mutationFn: (name: string) => api.delete<AutoBackupStatus>(`/backup/auto/files/${encodeURIComponent(name)}`),
      onSuccess,
      onError: () => qc.invalidateQueries({ queryKey: ['auto-backup'] }),
    }),
  };
}

// ---- Updates ----

/** Set in this tab once it starts an update, so it reloads itself when the new version answers. */
const UPDATING_KEY = 'crafty-updating';

let reloading = false;

/**
 * Reloads once the new version's page and the scripts and styles it names all load,
 * checking every couple of seconds (and giving up after a minute, reloading anyway).
 * The server answering isn't enough: the HTTPS proxy in front may still be restarting,
 * and reloading then left a blank page.
 */
async function reloadWhenReady() {
  if (reloading) return;
  reloading = true;
  const loads = async (url: string) => (await fetch(url, { cache: 'no-store' })).ok;
  for (let attempt = 0; attempt < 30; attempt++) {
    await new Promise((r) => setTimeout(r, 2000));
    try {
      const res = await fetch('/', { cache: 'no-store' });
      if (!res.ok) continue;
      const page = new DOMParser().parseFromString(await res.text(), 'text/html');
      const files = [
        ...[...page.querySelectorAll<HTMLScriptElement>('script[src]')].map((s) => s.getAttribute('src')!),
        ...[...page.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"][href]')].map((l) => l.getAttribute('href')!),
      ];
      if (files.length > 0 && (await Promise.all(files.map(loads))).every(Boolean)) break;
    } catch {
      // Not answering yet.
    }
  }
  window.location.reload();
}

/**
 * The server's update status. Refetched hourly, and every few seconds
 * during an update, through the restart (when requests fail for a while).
 */
export const useUpdates = () => {
  const query = useQuery({
    queryKey: ['updates'],
    queryFn: () => api.get<UpdateStatus>('/updates'),
    refetchInterval: (q) => (q.state.data?.applying ? 3000 : 60 * 60 * 1000),
    retry: (count) => count < 2 || !!sessionStorage.getItem(UPDATING_KEY),
  });
  const running = query.data?.currentVersion;
  const applying = !!query.data?.applying;
  useEffect(() => {
    if (!running || !sessionStorage.getItem(UPDATING_KEY)) return;
    if (running !== APP_VERSION) {
      sessionStorage.removeItem(UPDATING_KEY);
      void reloadWhenReady();
    } else if (!applying) {
      sessionStorage.removeItem(UPDATING_KEY); // it failed, and the same version is still running
    }
  }, [running, applying]);
  return query;
};

export function useUpdateMutations() {
  const qc = useQueryClient();
  const onSuccess = (data: UpdateStatus) => qc.setQueryData(['updates'], data);
  return {
    check: useMutation({ mutationFn: () => api.post<UpdateStatus>('/updates/check'), onSuccess }),
    apply: useMutation({
      mutationFn: (version: string) => api.post<UpdateStatus>('/updates/apply', { version }),
      onSuccess: (data) => {
        sessionStorage.setItem(UPDATING_KEY, data.applying?.version ?? '1');
        onSuccess(data);
      },
      onError: () => qc.invalidateQueries({ queryKey: ['updates'] }),
    }),
  };
}

// ---- Notifications ----

/** The signed-in person's unread notifications, for the bell. Live updates refetch it; hourly as a fallback. */
export const useNotifications = () =>
  useQuery({
    queryKey: ['notifications'],
    queryFn: () => api.get<NotificationsResponse>('/notifications'),
    refetchInterval: 60 * 60 * 1000,
  });

export function useNotificationMutations() {
  const qc = useQueryClient();
  const onSuccess = (data: NotificationsResponse) => qc.setQueryData(['notifications'], data);
  // Gone from the list straight away; the server's answer (or a refetch on failure) settles it.
  const hide = (keep: (id: number) => boolean) =>
    qc.setQueryData<NotificationsResponse>(['notifications'], (old) => old && { notifications: old.notifications.filter((n) => keep(n.id)) });
  const onError = () => qc.invalidateQueries({ queryKey: ['notifications'] });
  return {
    markRead: useMutation({
      mutationFn: (id: number) => api.post<NotificationsResponse>(`/notifications/${id}/read`),
      onMutate: (id) => hide((n) => n !== id),
      onSuccess,
      onError,
    }),
    markAllRead: useMutation({
      mutationFn: () => api.post<NotificationsResponse>('/notifications/read-all'),
      onMutate: () => hide(() => false),
      onSuccess,
      onError,
    }),
  };
}

// ---- HMRC ----

export const HMRC_OBLIGATIONS = 'hmrc-obligations';

export const useHmrc = () => useQuery({ queryKey: ['hmrc'], queryFn: () => api.get<HmrcStatus>('/hmrc') });

/** Whether HMRC can calculate the tax for a year: connected, with a NINO, from 2025/26. */
export function useHmrcCalculationAvailable(taxYearLabel: string | undefined): boolean {
  const { data: hmrc } = useHmrc();
  return Boolean(hmrc?.connection && hmrc.nino) && (startYearFromLabel(taxYearLabel ?? '') ?? 0) >= MTD_FIRST_SEND_YEAR;
}

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
 * A tax calculation just asked of HMRC, checked every 5 seconds until HMRC has
 * worked it out. Nothing is fetched until there's one to check.
 */
export function useHmrcCalculation(taxYearId: number | undefined, calculationId: string | null) {
  return useQuery({
    queryKey: [HMRC_CALCULATION, taxYearId, calculationId],
    queryFn: () => api.get<HmrcCalculationResponse>(`/hmrc/calculations/${taxYearId}${toQuery({ calculationId })}`),
    enabled: calculationId !== null && taxYearId !== undefined,
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

/** What's agreed to at HMRC after the tax year: the final declaration, then any amendments to it. */
export type HmrcAgreement = 'declaration' | 'amendment';

const agreementPath = (taxYearId: number | undefined, kind: HmrcAgreement) =>
  `/hmrc/final-declaration/${taxYearId}${kind === 'amendment' ? '/amendment' : ''}`;

/** Asks HMRC for the calculation a final declaration (or an amendment) agrees to. */
export function useTriggerAgreementCalculation(taxYearId: number | undefined, kind: HmrcAgreement) {
  return useMutation({
    mutationFn: () => api.post<{ calculationId: string }>(`${agreementPath(taxYearId, kind)}/calculation`),
  });
}

/** Agrees to HMRC's calculation, as shown: the server refuses (409) if HMRC's total has changed since. */
export function useAgreeToCalculation(taxYearId: number | undefined, kind: HmrcAgreement) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (agreed: { calculationId: string; totalDuePence: number }) =>
      api.post<MtdFinalDeclaration>(agreementPath(taxYearId, kind), agreed),
    onSettled: () => {
      qc.invalidateQueries({ queryKey: ['mtd', taxYearId] });
      qc.invalidateQueries({ queryKey: [HMRC_OBLIGATIONS] });
      // HMRC may have refused the sign-in, which the server then forgets.
      qc.invalidateQueries({ queryKey: ['hmrc'] });
    },
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

export const useYearComparison = (taxYearId: number | undefined, compareToId: number | undefined, period: ComparisonPeriod) =>
  useQuery({
    queryKey: ['reports', 'year-comparison', taxYearId, compareToId, period],
    queryFn: () => api.get<YearComparisonResponse>(`/reports/year-comparison${toQuery({ taxYearId, compareToId, period })}`),
    enabled: taxYearId !== undefined && compareToId !== undefined,
    placeholderData: (prev) => prev,
  });

export type BreakdownSelection ={ categoryId: number; group: boolean } | { payee: string } | { flatRate: FlatRateKind };

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
