import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { QueryClient, QueryClientProvider, useQueryClient } from '@tanstack/react-query';
import { ErrorBoundary } from '@/components/error-boundary';
import { Toaster } from '@/components/ui/toaster';
import { TooltipProvider } from '@/components/ui/tooltip';
import NotFound from '@/pages/not-found';
import { Route, Switch, useSearchParams, Router as WouterRouter } from 'wouter';
import {
  ArrowDownToLine, ArrowRight, Check, Copy, File, FileText, Flame, Moon,
  Smartphone, Sun, Upload,
} from 'lucide-react';
import {
  getGetRoomQueryKey, useBurnRoom, useCreateRoom, useDownloadRoomFile,
  useGetRoom, uploadRoomFile,
} from '@workspace/api-client-react';
import type { Room, RoomFile } from '@workspace/api-client-react';
import { io } from 'socket.io-client';
import QRCode from 'qrcode';

const queryClient = new QueryClient();
const MAX_FILES_PER_ROOM = 10;
const MAX_FILE_SIZE = 25 * 1024 * 1024;

function AppHome() {
  const [searchParams, setSearchParams] = useSearchParams();
  const queryClientForPage = useQueryClient();
  const pin = searchParams.get('pin')?.replace(/\D/g, '').slice(0, 6) || '';
  const notice = searchParams.get('notice');
  const roomQuery = useGetRoom(pin, {
    query: { enabled: pin.length === 6, queryKey: getGetRoomQueryKey(pin), retry: false },
  });
  const createRoom = useCreateRoom();
  const [joinPin, setJoinPin] = useState('');
  const [requestError, setRequestError] = useState('');
  const [dark, setDark] = useState(() => localStorage.getItem('ephemeral-theme') === 'dark');
  const [installPrompt, setInstallPrompt] = useState<BeforeInstallPromptEvent | null>(null);

  useEffect(() => {
    document.documentElement.classList.toggle('dark', dark);
    localStorage.setItem('ephemeral-theme', dark ? 'dark' : 'light');
  }, [dark]);

  useEffect(() => {
    const handler = (event: Event) => {
      event.preventDefault();
      setInstallPrompt(event as BeforeInstallPromptEvent);
    };
    window.addEventListener('beforeinstallprompt', handler);
    return () => window.removeEventListener('beforeinstallprompt', handler);
  }, []);

  const enterRoom = useCallback((newPin: string) => {
    setSearchParams({ pin: newPin });
  }, [setSearchParams]);
  const returnHome = useCallback(() => setSearchParams(''), [setSearchParams]);
  const returnHomeAfterExpiry = useCallback(() => setSearchParams({ notice: 'expired' }), [setSearchParams]);
  const returnHomeAfterBurn = useCallback(() => setSearchParams({ notice: 'burned' }), [setSearchParams]);

  const handleCreate = () => {
    setRequestError('');
    createRoom.mutate(undefined, {
      onSuccess: (room) => {
        queryClientForPage.setQueryData(getGetRoomQueryKey(room.pin), room);
        enterRoom(room.pin);
      },
      onError: () => setRequestError('Could not create a room. Check your connection and try again.'),
    });
  };

  const handleJoin = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const cleaned = joinPin.replace(/\D/g, '').slice(0, 6);
    if (cleaned.length !== 6) {
      setRequestError('Enter all six digits to join a room.');
      return;
    }
    setRequestError('');
    enterRoom(cleaned);
  };

  const promptInstall = async () => {
    if (!installPrompt) return;
    await installPrompt.prompt();
    setInstallPrompt(null);
  };

  if (pin.length === 6) {
    if (roomQuery.isLoading || roomQuery.isFetching && !roomQuery.data) return <LoadingRoom dark={dark} onToggle={() => setDark(!dark)} />;
    if (roomQuery.isError || !roomQuery.data) {
      return <RoomUnavailable pin={pin} dark={dark} onToggle={() => setDark(!dark)} onBack={returnHome} onRetry={() => roomQuery.refetch()} />;
    }
    return <ActiveRoom initialRoom={roomQuery.data} dark={dark} onToggle={() => setDark(!dark)} onLeave={returnHome} onExpire={returnHomeAfterExpiry} onBurned={returnHomeAfterBurn} />;
  }

  return (
    <div className="app-shell">
      <Topbar dark={dark} onToggle={() => setDark(!dark)} installPrompt={installPrompt} onInstall={promptInstall} />
      <main className="home-layout">
        {(notice === 'expired' || notice === 'burned') && (
          <div className="session-notice" role="status" data-testid="status-session-ended">
            <span className="session-notice-mark" aria-hidden="true" />
            <span>{notice === 'expired' ? 'Session Expired — the room and its files have been deleted.' : 'Room burned — the room and its files have been deleted.'}</span>
          </div>
        )}
        <section>
          <div className="home-intro">
            <div className="eyebrow">A temporary space between your devices</div>
            <h1 className="home-title">Move it over.<br />Leave nothing behind.</h1>
            <p className="home-desc">A private room for the text and files you need on another screen. No account. No history. Gone in 15 minutes.</p>
          </div>
          <div className="home-foot"><span>01 / CREATE OR JOIN</span><span>Rooms expire automatically</span></div>
        </section>
        <section className="entry-panel" aria-label="Create or join a temporary room">
          <div className="entry-block">
            <div className="section-label"><span>Start a new room</span><span className="muted-label">15 MINUTES</span></div>
            <button className="primary-button" data-testid="button-create-room" onClick={handleCreate} disabled={createRoom.isPending}>
              <span>{createRoom.isPending ? 'Opening a room…' : 'Create room'}</span>
              {createRoom.isPending ? <span className="skeleton-line" /> : <ArrowRight size={16} />}
            </button>
          </div>
          <div className="entry-block">
            <div className="section-label"><span>Already have a PIN?</span><span className="muted-label">6 DIGITS</span></div>
            <form className="join-row" onSubmit={handleJoin}>
              <input
                className="pin-input"
                aria-label="Room PIN"
                data-testid="input-room-pin"
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={6}
                placeholder="000000"
                value={joinPin}
                onChange={(event) => setJoinPin(event.target.value.replace(/\D/g, '').slice(0, 6))}
              />
              <button className="join-button" data-testid="button-join-room" type="submit">Join room</button>
            </form>
            {requestError && <p className="inline-error" role="alert" data-testid="status-home-error">{requestError}</p>}
          </div>
        </section>
      </main>
    </div>
  );
}

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
}

function Topbar({ dark, onToggle, installPrompt, onInstall }: {
  dark: boolean; onToggle: () => void; installPrompt?: BeforeInstallPromptEvent | null; onInstall?: () => void;
}) {
  return (
    <header className="topbar">
      <div className="wordmark"><span className="mark" aria-hidden="true" />Ephemeral Sync</div>
      <div className="top-actions">
        <span className="top-note">No login. No long-term storage.</span>
        {installPrompt && onInstall && <button className="icon-button install-button" aria-label="Install app" data-testid="button-install" onClick={onInstall}><Smartphone size={15} /></button>}
        <button className="icon-button" aria-label={dark ? 'Switch to light mode' : 'Switch to dark mode'} data-testid="button-theme-toggle" onClick={onToggle}>{dark ? <Sun size={15} /> : <Moon size={15} />}</button>
      </div>
    </header>
  );
}

function LoadingRoom({ dark, onToggle }: { dark: boolean; onToggle: () => void }) {
  return <div className="app-shell"><Topbar dark={dark} onToggle={onToggle} /><div className="loading-state"><div><div className="skeleton-line" />Joining room…</div></div></div>;
}

function RoomUnavailable({ pin, dark, onToggle, onBack, onRetry }: {
  pin: string; dark: boolean; onToggle: () => void; onBack: () => void; onRetry: () => void;
}) {
  return (
    <div className="app-shell">
      <Topbar dark={dark} onToggle={onToggle} />
      <div className="error-state">
        <div className="error-card">
          <div className="eyebrow">Room {pin}</div>
          <h2>This room isn't available.</h2>
          <p>It may have expired, been burned, or the PIN may be incorrect. Rooms are temporary by design.</p>
          <button className="primary-button" data-testid="button-retry-room" onClick={onRetry}><span>Try again</span><ArrowRight size={15} /></button>
          <button className="text-action" style={{ marginTop: 13 }} data-testid="button-back-home" onClick={onBack}>Back to start</button>
        </div>
      </div>
    </div>
  );
}

function ActiveRoom({ initialRoom, dark, onToggle, onLeave, onExpire, onBurned }: {
  initialRoom: Room; dark: boolean; onToggle: () => void; onLeave: () => void; onExpire: () => void; onBurned: () => void;
}) {
  const queryClientForRoom = useQueryClient();
  const pin = initialRoom.pin;
  const [text, setText] = useState(initialRoom.text);
  const [files, setFiles] = useState<RoomFile[]>(initialRoom.files || []);
  const [expiresAt, setExpiresAt] = useState(initialRoom.expiresAt);
  const [remaining, setRemaining] = useState(900);
  const [connected, setConnected] = useState(false);
  const [mobileTab, setMobileTab] = useState<'text' | 'files'>('text');
  const [copied, setCopied] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [uploadError, setUploadError] = useState('');
  const [burnError, setBurnError] = useState('');
  const [qrData, setQrData] = useState('');
  const socketRef = useRef<ReturnType<typeof io> | null>(null);
  const textRef = useRef(text);
  const editTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const expiryHandled = useRef(false);
  const burnRoom = useBurnRoom();
  const [uploadingCount, setUploadingCount] = useState(0);

  useEffect(() => {
    textRef.current = text;
  }, [text]);

  useEffect(() => {
    setText(initialRoom.text);
    setFiles(initialRoom.files || []);
    setExpiresAt(initialRoom.expiresAt);
  }, [initialRoom]);

  useEffect(() => {
    let alive = true;
    QRCode.toDataURL(`${window.location.origin}/?pin=${pin}`, { width: 180, margin: 0, color: { dark: '#111111', light: '#ffffff' } })
      .then((data) => { if (alive) setQrData(data); })
      .catch(() => undefined);
    return () => { alive = false; };
  }, [pin]);

  useEffect(() => {
    const socketUrl = import.meta.env.VITE_API_BASE_URL?.trim() || undefined;
    const socket = io(socketUrl, { path: '/api/socket.io', transports: ['websocket', 'polling'] });
    socketRef.current = socket;
    const join = () => {
      setConnected(true);
      socket.emit('join-room', { pin });
    };
    const handleState = (state: Room) => {
      if (state.pin !== pin) return;
      setText(state.text || '');
      textRef.current = state.text || '';
      setExpiresAt(state.expiresAt);
      setFiles(state.files || []);
      queryClientForRoom.setQueryData(getGetRoomQueryKey(pin), state);
    };
    const handleFile = (payload: { file: RoomFile }) => {
      if (payload?.file) setFiles((current) => current.some((file) => file.id === payload.file.id) ? current : [...current, payload.file]);
    };
    const handleText = (payload: { text: string }) => {
      if (typeof payload?.text !== 'string') return;
      setText(payload.text);
      textRef.current = payload.text;
      queryClientForRoom.setQueryData<Room>(getGetRoomQueryKey(pin), (previous) => previous ? { ...previous, text: payload.text } : previous);
    };
    const handleExpired = (payload: { reason?: string }) => {
      if (expiryHandled.current) return;
      expiryHandled.current = true;
      queryClientForRoom.removeQueries({ queryKey: getGetRoomQueryKey(pin) });
      if (payload?.reason === 'burned') onBurned();
      else onExpire();
    };
    const disconnect = () => setConnected(false);
    socket.on('connect', join);
    socket.on('disconnect', disconnect);
    socket.on('connect_error', disconnect);
    socket.on('room-state', handleState);
    socket.on('text-update', handleText);
    socket.on('file-added', handleFile);
    socket.on('session-expired', handleExpired);
    if (socket.connected) join();
    return () => {
      if (editTimer.current) clearTimeout(editTimer.current);
      socket.disconnect();
      socketRef.current = null;
    };
  }, [pin, queryClientForRoom, onExpire, onBurned]);

  useEffect(() => {
    const tick = () => {
      const seconds = Math.max(0, Math.ceil((new Date(expiresAt).getTime() - Date.now()) / 1000));
      setRemaining(seconds);
      if (seconds <= 0 && !expiryHandled.current) {
        expiryHandled.current = true;
        onExpire();
      }
    };
    tick();
    const interval = window.setInterval(tick, 1000);
    return () => window.clearInterval(interval);
  }, [expiresAt, onExpire]);

  const updateText = (value: string) => {
    setText(value);
    textRef.current = value;
    if (editTimer.current) clearTimeout(editTimer.current);
    editTimer.current = setTimeout(() => socketRef.current?.emit('text-update', { text: textRef.current }), 150);
  };

  const copyAll = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      setCopied(false);
    }
  };

  const upload = async (selectedFiles: FileList | File[]) => {
    const chosen = Array.from(selectedFiles);
    if (!chosen.length) return;
    setUploadError('');

    const availableSlots = Math.max(0, MAX_FILES_PER_ROOM - files.length - uploadingCount);
    if (availableSlots <= 0) {
      setUploadError('This room has reached its 10-file limit.');
      return;
    }

    const errors: string[] = [];
    if (chosen.length > availableSlots) {
      errors.push(`Only ${availableSlots} more file${availableSlots === 1 ? '' : 's'} fit in this room.`);
    }

    const withinLimit = chosen.slice(0, availableSlots);
    const tooLarge = withinLimit.filter((file) => file.size > MAX_FILE_SIZE);
    if (tooLarge.length) {
      errors.push('Each file must be 25 MB or smaller.');
    }

    const filesToUpload = withinLimit.filter((file) => file.size <= MAX_FILE_SIZE);
    if (errors.length) {
      setUploadError(errors.join(' '));
    }
    if (!filesToUpload.length) return;

    setUploadingCount((c) => c + filesToUpload.length);

    for (const file of filesToUpload) {
      try {
        const newFile = await uploadRoomFile(pin, { file });
        setFiles((current) => current.some((item) => item.id === newFile.id) ? current : [...current, newFile]);
        queryClientForRoom.setQueryData<Room>(getGetRoomQueryKey(pin), (previous) => previous ? {
          ...previous,
          files: previous.files.some((item) => item.id === newFile.id) ? previous.files : [...previous.files, newFile],
        } : previous);
      } catch (err: unknown) {
        const errorObj = err as { data?: { error?: string }; message?: string };
        const msg = errorObj?.data?.error || errorObj?.message || `Couldn't upload ${file.name}. Try again.`;
        setUploadError(msg);
      } finally {
        setUploadingCount((c) => Math.max(0, c - 1));
      }
    }
  };

  const burn = () => {
    if (!window.confirm('Burn this room now? Its text and files will be permanently deleted.')) return;
    burnRoom.mutate({ pin }, {
      onSuccess: () => {
        queryClientForRoom.removeQueries({ queryKey: getGetRoomQueryKey(pin) });
        if (!expiryHandled.current) {
          expiryHandled.current = true;
          onBurned();
        }
      },
      onError: () => setBurnError('Room could not be burned. Try again.'),
    });
  };

  const countWords = useMemo(() => text.trim() ? text.trim().split(/\s+/).length : 0, [text]);
  const timeLabel = `${String(Math.floor(remaining / 60)).padStart(2, '0')}:${String(remaining % 60).padStart(2, '0')}`;
  const formatSize = (bytes: number) => bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / (1024 * 1024)).toFixed(1)} MB`;

  return (
    <div className="app-shell">
      <Topbar dark={dark} onToggle={onToggle} />
      <main className="room-shell">
        <header className="room-header">
          <div className="room-id-wrap">
            <div><span className="room-id-label">Room PIN</span><span className="room-pin" data-testid="text-room-pin">{pin}</span></div>
            <div className="room-status" data-testid="status-connection"><span className={`status-dot ${connected ? '' : 'offline'}`} /><span>{connected ? 'Live' : 'Connecting'}</span></div>
          </div>
          <div className="room-tools">
            <span className="countdown" data-testid="text-countdown">{timeLabel}</span>
              <button className="quiet-button burn-button" aria-label="Burn room now" data-testid="button-burn-room" onClick={burn} disabled={burnRoom.isPending}><Flame size={13} /><span>{burnRoom.isPending ? 'Burning' : 'Burn room now'}</span></button>
          </div>
        </header>
        {burnError && <p className="upload-error" role="alert" data-testid="status-burn-error">{burnError}</p>}
        <div className="room-grid">
          <section className={`workspace ${mobileTab === 'text' ? 'mobile-active' : ''}`} aria-label="Shared notepad">
            <div className="workspace-toolbar">
              <span className="tab-title">Notepad</span>
              <div className="toolbar-actions">
                <span className="muted-label">SYNCED LIVE</span>
                <button className="text-action" data-testid="button-copy-all" onClick={copyAll}>{copied ? <><Check size={12} style={{ verticalAlign: 'middle', marginRight: 4 }} />Copied</> : <><Copy size={12} style={{ verticalAlign: 'middle', marginRight: 4 }} />Copy all</>}</button>
              </div>
            </div>
            <textarea
              className="editor"
              aria-label="Shared text editor"
              data-testid="input-shared-text"
              placeholder="Type or paste text here. It appears on your other device as you write."
              spellCheck={false}
              value={text}
              onChange={(event) => updateText(event.target.value)}
            />
            <div className="editor-meta" data-testid="status-text-count"><span>{text.length} characters</span><span>{countWords} words</span></div>
          </section>
          <section className={`file-pane ${mobileTab === 'files' ? 'mobile-active' : ''}`} aria-label="Shared files">
            <div className="file-pane-head">
              <div className="section-label"><span>Files</span><span className="file-count" data-testid="text-file-count">{files.length.toString().padStart(2, '0')}</span></div>
            </div>
            <input
              ref={fileInput}
              type="file"
              multiple
              hidden
              data-testid="input-file-upload"
              onChange={(event) => { if (event.target.files) upload(event.target.files); event.target.value = ''; }}
            />
            <div
              className={`drop-zone ${dragging ? 'dragging' : ''}`}
              role="button"
              tabIndex={0}
              data-testid="button-file-upload"
              onClick={() => fileInput.current?.click()}
              onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') fileInput.current?.click(); }}
              onDragOver={(event) => { event.preventDefault(); setDragging(true); }}
              onDragLeave={() => setDragging(false)}
              onDrop={(event) => { event.preventDefault(); setDragging(false); upload(event.dataTransfer.files); }}
            >
              <Upload size={16} strokeWidth={1.5} />
              <span className="drop-title">{uploadingCount > 0 ? `Uploading (${uploadingCount} remaining)…` : files.length >= MAX_FILES_PER_ROOM ? '10-file limit reached' : 'Drop files here or browse'}</span>
              <span className="drop-hint">Up to 10 files · 25 MB each · any format · removed when this room ends</span>
            </div>
            {uploadError && <p className="upload-error" role="alert" data-testid="status-upload-error">{uploadError}</p>}
            <div className="file-list">
              {files.length ? files.map((file) => <FileCard key={file.id} file={file} pin={pin} formatSize={formatSize} />) : <p className="empty-files">Nothing shared yet.<br />Add a file to move it across.</p>}
            </div>
            <div className="qr-panel">
              {qrData ? <img className="qr-image" src={qrData} alt={`QR code to join room ${pin}`} data-testid="img-room-qr" /> : <div className="qr-image" aria-label="Creating QR code" />}
              <div className="qr-copy"><div className="qr-title">Join on Android</div><div className="qr-pin" data-testid="text-qr-pin">{pin}</div><div className="qr-sub">Scan this code to open the same room on your phone.</div></div>
            </div>
          </section>
        </div>
        <nav className="room-mobile-tabs" aria-label="Room sections">
          <button className={`mobile-tab ${mobileTab === 'text' ? 'active' : ''}`} data-testid="tab-notepad" onClick={() => setMobileTab('text')}><FileText size={15} />Notepad</button>
          <button className={`mobile-tab ${mobileTab === 'files' ? 'active' : ''}`} data-testid="tab-files" onClick={() => setMobileTab('files')}><File size={15} />Files <span className="mobile-tab-count">{files.length}</span></button>
        </nav>
      </main>
    </div>
  );
}

function FileCard({ file, pin, formatSize }: { file: RoomFile; pin: string; formatSize: (bytes: number) => string }) {
  const [downloadError, setDownloadError] = useState(false);
  const download = useDownloadRoomFile(pin, file.id, {
    query: { enabled: false, queryKey: ['/api/rooms', pin, 'files', file.id, 'download'] },
    request: { responseType: 'blob' },
  });
  const onDownload = async () => {
    try {
      const result = await download.refetch();
      if (!result.data) return;
      const blob =
        result.data instanceof Blob
          ? result.data
          : new Blob([result.data as BlobPart], { type: file.mimeType || 'application/octet-stream' });
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = file.name;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
      setDownloadError(false);
    } catch {
      setDownloadError(true);
    }
  };
  return (
    <div className="file-card" data-testid={`card-file-${file.id}`}>
      <div className="file-icon"><FileText size={14} /></div>
      <div className="file-info"><div className="file-name" title={file.name}>{file.name}</div><div className="file-detail">{downloadError ? 'Download failed — try again' : formatSize(file.size)}</div></div>
      <button className="download-button" aria-label={`Download ${file.name}`} data-testid={`button-download-${file.id}`} onClick={onDownload} disabled={download.isFetching}>
        {download.isFetching ? <span className="muted-label">…</span> : <><ArrowDownToLine size={14} /><span>Download</span></>}
      </button>
    </div>
  );
}

function Router() {
  return (
    <ErrorBoundary>
      <Switch>
        <Route path="/" component={AppHome} />
        <Route component={NotFound} />
      </Switch>
    </ErrorBoundary>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, '')}>
          <Router />
        </WouterRouter>
        <Toaster />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
