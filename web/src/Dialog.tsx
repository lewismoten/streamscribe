import { useLayoutEffect, useRef, type ReactNode } from 'react';

// A modal dialog (the browser's own <dialog>): open while it's shown, closed by Escape or its ✕ button. Focus goes inside when it opens and back where it was when it closes.
export default function Dialog({
  title,
  onClose,
  children
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  // Opened before what's inside it runs its own effects, so a form inside can put focus where it wants it.
  useLayoutEffect(() => {
    const dialog = ref.current;
    if (dialog && !dialog.open) dialog.showModal();
    return () => dialog?.close();
  }, []);
  return (
    <dialog ref={ref} className="dialog" aria-label={title} onClose={onClose}>
      <div className="dialog-head">
        <strong>{title}</strong>
        <button type="button" className="link-button" onClick={onClose} aria-label="Close">
          ✕
        </button>
      </div>
      {children}
    </dialog>
  );
}
