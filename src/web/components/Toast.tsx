import React, { createContext, useContext, useState, useCallback, useMemo, useRef } from 'react';

type ToastType = 'success' | 'error' | 'info' | 'progress';

interface Toast {
  id: number;
  type: ToastType;
  message: string;
  exiting?: boolean;
  progress?: { current: number; total: number; label?: string };
  sticky?: boolean;
}

interface ToastContextValue {
  toast: (type: ToastType, message: string) => void;
  success: (message: string) => void;
  error: (message: string) => void;
  info: (message: string) => void;
  progress: (id: number, current: number, total: number, label?: string) => void;
  startProgress: (total: number, label?: string) => number;
  finishProgress: (id: number, summary: string, type?: ToastType) => void;
  removeToast: (id: number) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

export function useToast() {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast must be used within ToastProvider');
  return ctx;
}

const icons: Record<ToastType, React.ReactNode> = {
  success: <svg width="18" height="18" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M5 13l4 4L19 7" /></svg>,
  error: <svg width="18" height="18" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M6 18L18 6M6 6l12 12" /></svg>,
  info: <svg width="18" height="18" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>,
  progress: <svg width="18" height="18" fill="none" viewBox="0 0 24 24" stroke="currentColor" className="toast-spinner-icon"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M4 4v5h.582m15.356 6A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" /></svg>,
};

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const idRef = useRef(0);

  const removeToast = useCallback((id: number) => {
    setToasts(prev => prev.map(t => t.id === id ? { ...t, exiting: true } : t));
    setTimeout(() => {
      setToasts(prev => prev.filter(t => t.id !== id));
    }, 250);
  }, []);

  const addToast = useCallback((type: ToastType, message: string) => {
    const id = ++idRef.current;
    setToasts(prev => [...prev, { id, type, message }]);
    setTimeout(() => removeToast(id), 3200);
  }, [removeToast]);

  const startProgress = useCallback((total: number, label?: string) => {
    const id = ++idRef.current;
    setToasts(prev => [...prev, { id, type: 'progress', message: label || '处理中...', sticky: true, progress: { current: 0, total, label } }]);
    return id;
  }, []);

  const updateProgress = useCallback((id: number, current: number, total: number, label?: string) => {
    setToasts(prev => prev.map(t => t.id === id ? { ...t, progress: { current, total, label }, message: label || t.message } : t));
  }, []);

  const finishProgress = useCallback((id: number, summary: string, type: ToastType = 'success') => {
    setToasts(prev => prev.map(t => t.id === id ? { ...t, type, message: summary, sticky: false, progress: undefined } : t));
    setTimeout(() => removeToast(id), 3200);
  }, [removeToast]);

  const success = useCallback((msg: string) => addToast('success', msg), [addToast]);
  const error = useCallback((msg: string) => addToast('error', msg), [addToast]);
  const info = useCallback((msg: string) => addToast('info', msg), [addToast]);

  const value = useMemo<ToastContextValue>(() => ({
    toast: addToast,
    success,
    error,
    info,
    progress: updateProgress,
    startProgress,
    finishProgress,
    removeToast,
  }), [addToast, error, info, success, updateProgress, startProgress, finishProgress, removeToast]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="toast-container">
        {toasts.map(t => (
          <div
            key={t.id}
            className={`toast toast-${t.type} ${t.exiting ? 'toast-exit' : ''}`}
            onClick={() => !t.sticky && removeToast(t.id)}
            style={{ cursor: t.sticky ? 'default' : 'pointer' }}
          >
            <span style={{ flexShrink: 0, marginTop: 1 }}>{icons[t.type]}</span>
            <span style={{ fontSize: 13, lineHeight: 1.5, flex: 1, minWidth: 0 }}>
              {t.message}
              {t.progress && t.progress.total > 0 && (
                <div className="toast-progress-detail">
                  <div className="toast-progress-bar-track">
                    <div
                      className="toast-progress-bar-fill"
                      style={{ width: `${Math.round((t.progress.current / t.progress.total) * 100)}%` }}
                    />
                  </div>
                  <span className="toast-progress-count">{t.progress.current}/{t.progress.total}</span>
                </div>
              )}
            </span>
            {!t.sticky && <div className="toast-timer-bar" />}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}
