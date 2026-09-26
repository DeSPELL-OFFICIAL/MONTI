import { Pressable } from '../motion';

export function Fab({ label, onClick, disabled }: { label: string; onClick: () => void; disabled?: boolean }) {
  return (
    <Pressable type="button" className="fab" onClick={onClick} disabled={disabled}>
      {label}
    </Pressable>
  );
}
