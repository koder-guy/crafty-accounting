import { useRef, useState, type DragEvent } from 'react';
import { FileText, FileUp, LoaderCircle, RotateCw, ScanText, Trash2 } from 'lucide-react';
import { diskSize, formatDisplayDate, formatGBP, MAX_PHOTO_BYTES, photoFilename, type Scan, type ScanList } from '@crafty/shared';
import { ConfirmDialog } from '../components/ConfirmDialog';
import { BackLink } from '../components/FormShell';
import { PageBody, PageHeader } from '../components/PageHeader';
import { tableUrl } from '../components/transactions';
import { Alert, Badge, Button, ButtonLink, Card, CardHeader, EmptyState, IconButton, Spinner } from '../components/ui';
import { ApiError } from '../lib/api';
import { compressPhoto } from '../lib/compressPhoto';
import { openInDocumentWindow } from '../lib/documentWindow';
import { scanFileUrl, useScanMutations, useScans } from '../lib/queries';

const CAMERA_DEFAULT_NAME = /^image\.\w+$/i;
const ACCEPT = '.pdf,.jpg,.jpeg,.png,.webp,.heic,.heif,application/pdf,image/*';

const documents = (n: number) => `${n} ${n === 1 ? 'document' : 'documents'}`;

/** Scans that can be opened in the expense form: read, or not readable (to fill in by hand). */
const checkable = (s: Scan) => s.status === 'ready' || s.status === 'failed';

/** The scan to check after `afterId`: the next one in order that's ready, else the first from the start. */
export function nextScanToCheck(scans: Scan[], afterId?: number): Scan | null {
  const open = scans.filter((s) => checkable(s) && s.id !== afterId);
  return open.find((s) => afterId === undefined || s.id > afterId) ?? open[0] ?? null;
}

export const scanCheckUrl = (id: number) => `/expenses/new?scan=${id}`;

/** What a file will take on the server: photos are made into a JPEG of at most MAX_PHOTO_BYTES first. */
const expectedBytes = (file: File) => (file.type.startsWith('image/') ? Math.min(file.size, MAX_PHOTO_BYTES) : file.size);

/** Room left for documents before the disk reaches the minimum, or null if the server can't tell. */
const roomFor = (list: ScanList) => (list.space ? Math.max(0, list.space.freeBytes - list.space.minimumFreeBytes) : null);

type Stage =
  | { step: 'tooMuch'; files: File[]; fits: number; neededBytes: number; roomBytes: number }
  | { step: 'adding'; done: number; total: number }
  | { step: 'added'; added: number; problems: { name: string; message: string }[] };

/** Expenses → Scan documents: add many invoices and receipts at once, then check each one Claude has read. */
export function ScanDocuments() {
  const { data, isLoading, error } = useScans();
  const { add, retry, discard } = useScanMutations();
  const inputRef = useRef<HTMLInputElement>(null);
  const [stage, setStage] = useState<Stage | null>(null);
  const [tooLarge, setTooLarge] = useState<string[]>([]);
  const [dragging, setDragging] = useState(false);
  const dragDepth = useRef(0);
  const [discarding, setDiscarding] = useState<Scan | null>(null);
  const adding = stage?.step === 'adding';

  const upload = async (files: File[]) => {
    const problems: { name: string; message: string }[] = [];
    let added = 0;
    for (const [i, picked] of files.entries()) {
      setStage({ step: 'adding', done: i, total: files.length });
      try {
        // Photos become a JPEG small enough for Claude to read, as Read an invoice does.
        let file = picked;
        if (picked.type.startsWith('image/')) {
          const compressed = await compressPhoto(picked);
          if (compressed !== picked || CAMERA_DEFAULT_NAME.test(picked.name)) {
            file = new File([compressed], photoFilename(compressed), { type: compressed.type, lastModified: picked.lastModified });
          }
        }
        await add.mutateAsync(file);
        added++;
      } catch (err) {
        problems.push({ name: picked.name, message: (err as Error).message });
        // The disk is too full for the rest too.
        if (err instanceof ApiError && err.status === 507) {
          const left = files.length - i - 1;
          if (left) problems.push({ name: documents(left), message: 'Not added, for the same reason.' });
          break;
        }
      }
    }
    setStage({ step: 'added', added, problems });
  };

  const choose = (picked: File[]) => {
    if (inputRef.current) inputRef.current.value = '';
    if (!picked.length || !data || adding) return;
    const big = picked.filter((f) => f.size > data.maxUploadBytes && !f.type.startsWith('image/'));
    setTooLarge(big.map((f) => f.name));
    const files = picked.filter((f) => !big.includes(f));
    if (!files.length) {
      setStage(null);
      return;
    }
    const room = roomFor(data);
    const neededBytes = files.reduce((sum, f) => sum + expectedBytes(f), 0);
    if (room !== null && neededBytes > room) {
      let fits = 0;
      let used = 0;
      for (const f of files) {
        if (used + expectedBytes(f) > room) break;
        used += expectedBytes(f);
        fits++;
      }
      setStage({ step: 'tooMuch', files, fits, neededBytes, roomBytes: room });
      return;
    }
    void upload(files);
  };

  const takesDrag = (e: DragEvent) => e.dataTransfer.types.includes('Files') && !adding;
  const scans = data?.scans ?? [];
  const ready = scans.filter((s) => s.status === 'ready').length;
  const inProgress = scans.filter((s) => s.status === 'waiting' || s.status === 'reading').length;
  const next = nextScanToCheck(scans);

  return (
    <>
      <PageHeader title="Scan documents" subtitle="Claude reads each one; you check it before it goes into the books" />
      <PageBody>
        <BackLink to={tableUrl('/expenses')}>Expenses</BackLink>
        {isLoading ? (
          <Spinner />
        ) : error || !data ? (
          <Alert>{error?.message ?? 'Could not load the scanned documents'}</Alert>
        ) : (
          <div className="max-w-[1100px] space-y-6">
            {data.claudeConfigured ? (
              <Card className="p-5 sm:p-6">
                <div className="flex items-start gap-3">
                  <ScanText className="mt-0.5 size-5 shrink-0 text-accent-soft" aria-hidden />
                  <div>
                    <h2 className="text-base font-semibold text-ink">Add invoices and receipts</h2>
                    <p className="mt-0.5 text-sm text-muted">
                      Choose or drop as many PDFs and photos as you like. Claude reads them a couple at a time, each one a request to your
                      Anthropic account, and you can leave this page while it does. Nothing goes into the books until you check it and save it.
                    </p>
                  </div>
                </div>
                <div
                  className={`mt-4 flex flex-col items-center justify-center gap-3 rounded-lg border border-dashed px-4 py-6 text-center transition-colors sm:flex-row sm:gap-4 ${
                    dragging ? 'border-accent-soft bg-accent-bg' : 'border-line-strong bg-surface-2/60'
                  }`}
                  onDragEnter={(e) => {
                    if (!takesDrag(e)) return;
                    e.preventDefault();
                    dragDepth.current += 1;
                    setDragging(true);
                  }}
                  onDragOver={(e) => {
                    if (!takesDrag(e)) return;
                    e.preventDefault();
                    e.dataTransfer.dropEffect = 'copy';
                  }}
                  onDragLeave={(e) => {
                    if (!takesDrag(e)) return;
                    dragDepth.current -= 1;
                    if (dragDepth.current <= 0) setDragging(false);
                  }}
                  onDrop={(e) => {
                    dragDepth.current = 0;
                    setDragging(false);
                    if (!takesDrag(e)) return;
                    e.preventDefault();
                    choose([...e.dataTransfer.files]);
                  }}
                >
                  <FileUp className={`size-6 shrink-0 ${dragging ? 'text-accent-soft' : 'text-faint'}`} aria-hidden />
                  <p className="text-sm text-muted">
                    {stage?.step === 'adding' ? `Adding ${stage.done + 1} of ${stage.total}…` : dragging ? 'Drop to add them' : 'Drag documents here, or'}
                  </p>
                  <Button type="button" variant="primary" busy={adding} onClick={() => inputRef.current?.click()}>
                    {adding ? 'Adding…' : 'Choose files'}
                  </Button>
                  <input
                    ref={inputRef}
                    type="file"
                    multiple
                    accept={ACCEPT}
                    className="hidden"
                    aria-label="Documents to scan"
                    onChange={(e) => choose([...(e.target.files ?? [])])}
                  />
                </div>
                {data.space && (
                  <p className="mt-2 text-xs text-faint">
                    Room for about {diskSize(roomFor(data) ?? 0)} more documents on the server ({diskSize(data.space.freeBytes)} free, keeping{' '}
                    {diskSize(data.space.minimumFreeBytes)} spare for the books and backups).
                  </p>
                )}
                {tooLarge.length > 0 && (
                  <div className="mt-4">
                    <Alert onDismiss={() => setTooLarge([])}>
                      Not added, as the most the server takes is {diskSize(data.maxUploadBytes)} a file: {tooLarge.join(', ')}.
                    </Alert>
                  </div>
                )}
                {stage?.step === 'tooMuch' && (
                  <div className="mt-4">
                    <Alert tone={stage.fits ? 'warning' : 'error'} onDismiss={() => setStage(null)}>
                      <p>
                        These {documents(stage.files.length)} need about {diskSize(stage.neededBytes)}, but the server has room for only{' '}
                        {diskSize(stage.roomBytes)} more before its disk is too full.{' '}
                        {stage.fits === 1 ? 'Only the first one fits.' : stage.fits ? `The first ${stage.fits} fit.` : 'Free up some space on the server, or keep fewer automatic backups, first.'}
                      </p>
                      {stage.fits > 0 && (
                        <div className="mt-3 flex flex-wrap gap-2">
                          <Button type="button" variant="primary" onClick={() => void upload(stage.files.slice(0, stage.fits))}>
                            {stage.fits === 1 ? 'Add just the first' : `Add the first ${stage.fits}`}
                          </Button>
                          <Button type="button" variant="ghost" onClick={() => setStage(null)}>
                            Cancel
                          </Button>
                        </div>
                      )}
                    </Alert>
                  </div>
                )}
                {stage?.step === 'added' && (
                  <div className="mt-4">
                    <Alert tone={stage.problems.length ? (stage.added ? 'warning' : 'error') : 'success'} onDismiss={() => setStage(null)}>
                      {stage.added > 0 && <p>Added {documents(stage.added)}. Each one can be checked as soon as Claude has read it.</p>}
                      {stage.problems.length > 0 && (
                        <>
                          <p className={stage.added ? 'mt-1' : ''}>Not added:</p>
                          <ul className="mt-1 list-disc pl-5">
                            {stage.problems.map((p) => (
                              <li key={p.name}>
                                {p.name}: {p.message}
                              </li>
                            ))}
                          </ul>
                        </>
                      )}
                    </Alert>
                  </div>
                )}
              </Card>
            ) : (
              <Alert tone="info">
                Adding documents needs an Anthropic API key, saved in Settings → Claude Integration.
                {inProgress > 0 && ' Documents waiting to be read will be read once one is saved.'}
              </Alert>
            )}

            <Card>
              <CardHeader
                icon={<FileText className="size-5 text-accent-soft" />}
                title="To check"
                action={
                  <div className="flex flex-wrap items-center gap-3">
                    {scans.length > 0 && (
                      <span className="text-sm text-muted">
                        {ready} ready{inProgress > 0 && ` · ${inProgress} being read`}
                      </span>
                    )}
                    {next && (
                      <ButtonLink to={scanCheckUrl(next.id)} variant="primary">
                        Start checking
                      </ButtonLink>
                    )}
                  </div>
                }
              />
              {scans.length === 0 ? (
                <EmptyState icon={<ScanText className="size-8" />} title="Nothing to check">
                  Documents you add appear here while Claude reads them, then wait for you to check each one and save it as an expense.
                </EmptyState>
              ) : (
                <div className="relative overflow-x-auto">
                  <table className="w-full min-w-[760px] text-sm">
                    <thead className="text-xs tracking-wide text-muted uppercase">
                      <tr className="border-y border-line">
                        <th scope="col" className="px-4 py-3 text-left font-medium">
                          Document
                        </th>
                        <th scope="col" className="w-28 px-4 py-3 text-left font-medium">
                          Date
                        </th>
                        <th scope="col" className="px-4 py-3 text-left font-medium">
                          Payee
                        </th>
                        <th scope="col" className="w-28 px-4 py-3 text-right font-medium">
                          Amount
                        </th>
                        <th scope="col" className="w-40 px-4 py-3 text-left font-medium">
                          Status
                        </th>
                        <th scope="col" className="w-36 px-4 py-3">
                          <span className="sr-only">Actions</span>
                        </th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-line">
                      {scans.map((scan) => (
                        <ScanRow
                          key={scan.id}
                          scan={scan}
                          canRetry={data.claudeConfigured}
                          retrying={retry.isPending && retry.variables === scan.id}
                          onRetry={() => retry.mutate(scan.id)}
                          onDiscard={() => setDiscarding(scan)}
                        />
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              {retry.error && (
                <div className="px-5 pb-5 sm:px-6">
                  <Alert onDismiss={() => retry.reset()}>{retry.error.message}</Alert>
                </div>
              )}
            </Card>
          </div>
        )}
        <ConfirmDialog
          open={discarding !== null}
          title="Discard this document?"
          confirmLabel="Discard"
          onConfirm={() => (discarding ? discard.mutateAsync(discarding.id) : undefined)}
          onClose={() => setDiscarding(null)}
        >
          <p>
            {discarding?.originalName} is removed from the documents to check, and its file is deleted. Nothing in the books changes.
          </p>
        </ConfirmDialog>
      </PageBody>
    </>
  );
}

function ScanRow({
  scan,
  canRetry,
  retrying,
  onRetry,
  onDiscard,
}: {
  scan: Scan;
  canRetry: boolean;
  retrying: boolean;
  onRetry: () => void;
  onDiscard: () => void;
}) {
  const r = scan.reading;
  const total = r ? (r.totalPence ?? r.lineItems.reduce((sum, li) => sum + li.amountPence, 0)) : null;
  const dash = <span className="text-faint">–</span>;
  return (
    <tr className="align-middle">
      <td className="px-4 py-3">
        <a
          href={scanFileUrl(scan.id)}
          target="_blank"
          rel="noreferrer"
          onClick={openInDocumentWindow}
          className="inline-flex max-w-[22rem] items-center gap-2 text-ink hover:text-accent-soft"
          title="Open the document"
        >
          <FileText className="size-4 shrink-0 text-faint" aria-hidden />
          <span className="truncate">{scan.originalName}</span>
        </a>
        {scan.error && <p className="mt-1 text-xs text-out-soft">{scan.error}</p>}
      </td>
      <td className="px-4 py-3 whitespace-nowrap text-muted">{r?.date ? formatDisplayDate(r.date) : dash}</td>
      <td className="px-4 py-3 text-ink">{r?.payee || dash}</td>
      <td className="tabular px-4 py-3 text-right text-out-soft">{total !== null ? formatGBP(total) : dash}</td>
      <td className="px-4 py-3 whitespace-nowrap">
        <ScanStatusBadge scan={scan} />
        {r && r.warnings.length > 0 && (
          <p className="mt-1 text-xs text-warn" title={r.warnings.join('\n')}>
            {r.warnings.length} {r.warnings.length === 1 ? 'thing' : 'things'} to look at
          </p>
        )}
      </td>
      <td className="px-4 py-3">
        <div className="flex items-center justify-end gap-1">
          {checkable(scan) && (
            <ButtonLink to={scanCheckUrl(scan.id)} className="!px-3 !py-1.5">
              Check
            </ButtonLink>
          )}
          {scan.status === 'failed' && canRetry && (
            <IconButton label="Read it again" onClick={onRetry} disabled={retrying}>
              <RotateCw className={`size-4 ${retrying ? 'animate-spin' : ''}`} />
            </IconButton>
          )}
          <IconButton label="Discard" tone="danger" onClick={onDiscard}>
            <Trash2 className="size-4" />
          </IconButton>
        </div>
      </td>
    </tr>
  );
}

function ScanStatusBadge({ scan }: { scan: Scan }) {
  switch (scan.status) {
    case 'waiting':
      return <Badge>Waiting</Badge>;
    case 'reading':
      return (
        <Badge tone="accent">
          <LoaderCircle className="mr-1 size-3 animate-spin" aria-hidden />
          Reading…
        </Badge>
      );
    case 'ready':
      return <Badge tone="ok">Ready to check</Badge>;
    case 'failed':
      return <Badge tone="out">Couldn't read</Badge>;
  }
}
