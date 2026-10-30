import { useEffect, useId, useRef, useState } from 'react';
import { LoaderCircle } from 'lucide-react';
import { photoFilename } from '@crafty/shared';
import { Alert, Button } from './ui';

/**
 * How this device can take a photo. Phones and tablets use their own camera app through
 * <input capture>, which also works over plain HTTP. Elsewhere that attribute is ignored, so
 * laptops use getUserMedia, which browsers only offer on HTTPS or localhost.
 */
export type CameraOption = 'phone' | 'webcam' | 'needsHttps';

function detectCameraOption(): CameraOption | null {
  if (window.matchMedia('(pointer: coarse)').matches) return 'phone';
  if (typeof navigator.mediaDevices?.getUserMedia === 'function') return 'webcam';
  return window.isSecureContext ? null : 'needsHttps';
}

/** Null when there's no way to take a photo here, such as a desktop with no camera plugged in. */
export function useCameraOption(): CameraOption | null {
  const [option] = useState(detectCameraOption);
  const [hasWebcam, setHasWebcam] = useState(true);

  useEffect(() => {
    if (option !== 'webcam') return;
    const devices = navigator.mediaDevices;
    const check = () =>
      devices
        .enumerateDevices()
        .then((found) => setHasWebcam(found.some((d) => d.kind === 'videoinput')))
        .catch(() => setHasWebcam(true));
    void check();
    devices.addEventListener('devicechange', check);
    return () => devices.removeEventListener('devicechange', check);
  }, [option]);

  return option === 'webcam' && !hasWebcam ? null : option;
}

const NEEDS_HTTPS =
  'Browsers only let a website use a computer’s camera over HTTPS, and this page is on plain HTTP. Choose a file instead, take the photo on a phone, or set up HTTPS (the Docker install includes it).';

function cameraProblem(err: unknown): string {
  switch ((err as DOMException).name) {
    case 'NotAllowedError':
      return 'The browser was refused access to the camera. Allow the camera for this site in the browser’s settings and try again, or choose a file instead.';
    case 'NotFoundError':
      return 'No camera was found on this device. Choose a file instead.';
    case 'NotReadableError':
      return 'The camera couldn’t be started. Another app may be using it: close that and try again, or choose a file instead.';
    default:
      return 'The camera couldn’t be started. Choose a file instead.';
  }
}

/** A live preview from the computer's camera: take a photo, check it, then use it or try again. */
export function CameraDialog({ onPhoto, onClose }: { onPhoto: (photo: File) => void; onClose: () => void }) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const titleId = useId();
  const [problem, setProblem] = useState<string | null>(() => (typeof navigator.mediaDevices?.getUserMedia === 'function' ? null : NEEDS_HTTPS));
  const [ready, setReady] = useState(false);
  const [photo, setPhoto] = useState<{ blob: Blob; url: string } | null>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog && !dialog.open) {
      dialog.showModal();
      contentRef.current?.focus();
    }
  }, []);

  // The camera stays on until the dialog closes, so trying again is instant.
  useEffect(() => {
    if (problem) return;
    let closed = false;
    let stream: MediaStream | undefined;
    navigator.mediaDevices
      .getUserMedia({ audio: false, video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } } })
      .then((started) => {
        stream = started;
        if (closed) return stopCamera(started);
        if (videoRef.current) videoRef.current.srcObject = started;
      })
      .catch((err: unknown) => {
        if (!closed) setProblem(cameraProblem(err));
      });
    return () => {
      closed = true;
      if (stream) stopCamera(stream);
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (photo) return () => URL.revokeObjectURL(photo.url);
  }, [photo]);

  const take = () => {
    const video = videoRef.current;
    if (!video) return;
    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    canvas.getContext('2d')?.drawImage(video, 0, 0);
    canvas.toBlob(
      (blob) => {
        if (blob) setPhoto({ blob, url: URL.createObjectURL(blob) });
        else setProblem('The photo couldn’t be saved. Choose a file instead.');
      },
      'image/jpeg',
      0.92,
    );
  };

  const use = () => {
    if (!photo) return;
    onPhoto(new File([photo.blob], photoFilename(photo.blob), { type: photo.blob.type }));
    onClose();
  };

  return (
    <dialog
      ref={dialogRef}
      aria-labelledby={titleId}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      className={`m-auto w-[calc(100%-32px)] ${problem ? 'max-w-md' : 'max-w-2xl'} rounded-[var(--radius-card)] border border-line bg-surface p-0 text-ink shadow-2xl backdrop:bg-black/70 backdrop:backdrop-blur-sm`}
    >
      <div ref={contentRef} tabIndex={-1} className="p-6 outline-none">
        <h2 id={titleId} className="text-base font-semibold">
          Take a photo
        </h2>

        {problem ? (
          <div className="mt-4">
            <Alert tone="warning">{problem}</Alert>
          </div>
        ) : (
          <div className="relative mt-4 overflow-hidden rounded-lg bg-black">
            <video
              ref={videoRef}
              autoPlay
              muted
              playsInline
              aria-label="Camera preview"
              onLoadedMetadata={() => setReady(true)}
              className="aspect-video max-h-[60vh] w-full object-contain"
            />
            {photo && <img src={photo.url} alt="The photo you took" className="absolute inset-0 size-full bg-black object-contain" />}
            {!ready && (
              <div className="absolute inset-0 flex items-center justify-center gap-2 px-4 text-center text-sm text-muted">
                <LoaderCircle className="size-5 shrink-0 animate-spin" aria-hidden />
                Starting the camera. Your browser may ask you to allow it.
              </div>
            )}
          </div>
        )}

        <div className="mt-6 flex justify-end gap-3">
          <Button type="button" variant="ghost" onClick={onClose}>
            {problem ? 'Close' : 'Cancel'}
          </Button>
          {!problem &&
            (photo ? (
              <>
                <Button type="button" onClick={() => setPhoto(null)}>
                  Try again
                </Button>
                <Button type="button" variant="primary" onClick={use}>
                  Use photo
                </Button>
              </>
            ) : (
              <Button type="button" variant="primary" onClick={take} disabled={!ready}>
                Take photo
              </Button>
            ))}
        </div>
      </div>
    </dialog>
  );
}

function stopCamera(stream: MediaStream) {
  for (const track of stream.getTracks()) track.stop();
}
