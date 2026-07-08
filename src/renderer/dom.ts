export interface Toast {
  show(message: string, isError?: boolean): void;
}

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

export function byId<T extends HTMLElement>(id: string): T {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing renderer element: #${id}`);
  return node as T;
}

export function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createToast(toast: HTMLElement): Toast {
  let toastTimer: number | undefined;

  return {
    show(message: string, isError = false): void {
      toast.textContent = message;
      toast.className = `toast show${isError ? ' error' : ''}`;
      window.clearTimeout(toastTimer);
      toastTimer = window.setTimeout(() => (toast.className = 'toast'), 3500);
    },
  };
}
