import { useRef, useState, type DragEvent } from 'react';
import { FileUp, Sparkles } from 'lucide-react';
import { photoFilename, type InvoiceReading } from '@crafty/shared';
import { compressPhoto } from '../lib/compressPhoto';
import { useReadInvoice } from '../lib/queries';
import { Alert, Button, Card } from './ui';

const CAMERA_DEFAULT_NAME = /^image\.\w+$/i;

/**
 * Offers to fill in a new expense from an invoice or receipt, read by Claude. Shown only when
 * the server has an Anthropic API key. The file read is passed on, to be attached as well.
 */
export function ReadInvoice({ onRead, onBusy }: { onRead: (reading: InvoiceReading, file: File) => void; onBusy: (busy: boolean) => void }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const read = useReadInvoice();
  const [preparing, setPreparing] = useState(false);
  const [warnings, setWarnings] = useState<string[] | null>(null);
  const [dropProblem, setDropProblem] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  // dragenter and dragleave fire for each child crossed, so count them.
  const dragDepth = useRef(0);

  const choose = async (picked: File | undefined) => {
    if (inputRef.current) inputRef.current.value = '';
    if (!picked) return;
    setWarnings(null);
    setDropProblem(null);
    read.reset();
    onBusy(true);
    try {
      // Photos become a JPEG small enough to send (and to attach), as Take photo does.
      let file = picked;
      if (picked.type.startsWith('image/')) {
        setPreparing(true);
        const compressed = await compressPhoto(picked);
        setPreparing(false);
        if (compressed !== picked || CAMERA_DEFAULT_NAME.test(picked.name)) {
          file = new File([compressed], photoFilename(compressed), { type: compressed.type, lastModified: picked.lastModified });
        }
      }
      const reading = await read.mutateAsync(file);
      setWarnings(reading.warnings);
      onRead(reading, file);
    } catch {
      // read.error shows it.
    } finally {
      setPreparing(false);
      onBusy(false);
    }
  };

  const busy = preparing || read.isPending;
  // preventDefault also tells DocumentField's window listener not to refuse the drop.
  const takesDrag = (e: DragEvent) => e.dataTransfer.types.includes('Files') && !busy;
  return (
    <Card className="p-5 sm:p-6">
      <div className="flex items-start gap-3">
        <Sparkles className="mt-0.5 size-5 shrink-0 text-accent-soft" aria-hidden />
        <div>
          <h2 className="text-base font-semibold text-ink">Read an invoice</h2>
          <p className="mt-0.5 text-sm text-muted">
            Claude reads a PDF or photo of an invoice or receipt and fills in this expense for you to check. It's attached too.
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
          const dropped = [...e.dataTransfer.files];
          if (dropped.length > 1) {
            setDropProblem('Drop one invoice at a time.');
            return;
          }
          void choose(dropped[0]);
        }}
      >
        <FileUp className={`size-6 shrink-0 ${dragging ? 'text-accent-soft' : 'text-faint'}`} aria-hidden />
        <p className="text-sm text-muted">{busy ? 'Claude is reading the invoice…' : dragging ? 'Drop to read it' : 'Drag an invoice here, or'}</p>
        <Button type="button" variant="primary" busy={busy} onClick={() => inputRef.current?.click()}>
          {busy ? 'Reading…' : 'Choose file'}
        </Button>
        <input
          ref={inputRef}
          type="file"
          accept=".pdf,.jpg,.jpeg,.png,.webp,.heic,.heif,application/pdf,image/*"
          className="hidden"
          aria-label="Invoice to read"
          onChange={(e) => void choose(e.target.files?.[0])}
        />
      </div>
      {dropProblem && (
        <div className="mt-4">
          <Alert onDismiss={() => setDropProblem(null)}>{dropProblem}</Alert>
        </div>
      )}
      {read.error && (
        <div className="mt-4">
          <Alert onDismiss={() => read.reset()}>{read.error.message}</Alert>
        </div>
      )}
      {warnings && (
        <div className="mt-4">
          <Alert tone={warnings.length ? 'warning' : 'success'} onDismiss={() => setWarnings(null)}>
            {warnings.length ? (
              <>
                <p>Filled in from the invoice. Check everything before saving, especially:</p>
                <ul className="mt-1 list-disc pl-5">
                  {warnings.map((w) => (
                    <li key={w}>{w}</li>
                  ))}
                </ul>
              </>
            ) : (
              'Filled in from the invoice. Check everything before saving.'
            )}
          </Alert>
        </div>
      )}
    </Card>
  );
}
