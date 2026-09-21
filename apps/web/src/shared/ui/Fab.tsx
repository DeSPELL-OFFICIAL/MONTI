export function Fab({ label, onClick, disabled }: { label: string; onClick: () => void; disabled?: boolean }) {
  return (
    <button type="button" className="fab" onClick={onClick} disabled={disabled}>
      {label}
    </button>
  );
}
