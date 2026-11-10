export function Alert({ children }: { children: string }) {
  return (
    <p role="alert" className="text-sm font-medium text-danger">
      {children}
    </p>
  );
}

export function SavedNote({ children }: { children: string }) {
  return (
    <p role="status" className="text-sm font-medium text-success">
      {children}
    </p>
  );
}
